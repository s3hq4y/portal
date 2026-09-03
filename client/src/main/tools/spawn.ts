/** Cross-platform command launching shared by foreground and background tools. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MAX_CAPTURE } from "./types";

export type ShellKind = "powershell" | "pwsh" | "cmd" | "sh" | "bash";
export type CommandMode = ShellKind | "direct";
export type TerminationReason = "exit" | "timeout" | "output_limit" | "spawn_error" | "stopped";

export interface CommandRequest {
  command?: string;
  executable?: string;
  args?: string[];
}

export interface SpawnCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  terminationReason: TerminationReason;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  shell: CommandMode;
  executable: string;
}

export interface SpawnOpts {
  shell?: ShellKind;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** When set on Windows, Linux commands are launched with `wsl.exe -d <distro>`. */
  wslDistro?: string;
  /** POSIX working directory passed as `wsl.exe --cd`. */
  posixCwd?: string;
}

export type CommandRunner = (
  request: CommandRequest | string,
  cwd: string,
  maxMs: number,
  opts?: SpawnOpts,
) => Promise<SpawnCommandResult>;

export interface PreparedCommand {
  executable: string;
  args: string[];
  shell: CommandMode;
  displayCommand: string;
  wslDistro?: string;
}

/** Bounded string buffer with stable offsets, used for stdout/stderr capture. */
export class TextRingBuffer {
  private buf = "";
  private droppedBytes = 0;
  oldestOffset = 0;

  get endOffset(): number {
    return this.oldestOffset + this.buf.length;
  }
  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  append(s: string): void {
    if (!s) return;
    this.buf += s;
    const overflow = this.buf.length - MAX_CAPTURE;
    if (overflow > 0) {
      this.buf = this.buf.slice(overflow);
      this.oldestOffset += overflow;
      this.droppedBytes += overflow;
    }
  }

  read(fromOffset: number | undefined, maxChars: number): { text: string; nextOffset: number; truncated: boolean } {
    const start = fromOffset ?? this.oldestOffset;
    const idx = start - this.oldestOffset;
    const truncated = idx < 0;
    const from = Math.max(0, idx);
    const text = this.buf.slice(from, from + maxChars);
    return { text, nextOffset: start + text.length, truncated };
  }

  toString(): string {
    return this.buf;
  }
}

// Map user-friendly aliases to a shell kind.
export function resolveShell(explicit?: string): ShellKind {
  const s = String(explicit ?? "").trim().toLowerCase();
  if (s === "cmd" || s === "cmd.exe") return "cmd";
  if (s === "pwsh" || s === "powershell-core" || s === "powershell7") return "pwsh";
  if (s === "powershell" || s === "powershell.exe" || s === "ps") return "powershell";
  if (s === "bash" || s === "bash.exe" || s === "git-bash") return "bash";
  if (s === "sh" || s === "zsh") return "sh";
  return process.platform === "win32" ? "powershell" : "sh";
}

function findExecutable(candidates: string[]): string | undefined {
  const pathDirs = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of pathDirs) {
      const full = path.join(dir.replace(/^"|"$/g, ""), candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

function findWslExe(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return (
    findExecutable([
      "wsl.exe",
      path.join(systemRoot, "System32", "wsl.exe"),
      path.join(systemRoot, "Sysnative", "wsl.exe"),
    ]) || "wsl.exe"
  );
}

function isWindowsNativeExecutable(executable: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(executable) ||
    executable.includes("\\") ||
    /\.(exe|bat|cmd|com)$/i.test(executable)
  );
}

function wantsWindowsShell(explicitShell?: string): boolean {
  const s = String(explicitShell ?? "").trim().toLowerCase();
  return (
    s === "cmd" ||
    s === "cmd.exe" ||
    s === "powershell" ||
    s === "powershell.exe" ||
    s === "ps" ||
    s === "pwsh" ||
    s === "powershell-core" ||
    s === "powershell7"
  );
}

function wrapWithWsl(
  distro: string,
  innerExe: string,
  innerArgs: string[],
  shell: CommandMode,
  displayCommand: string,
): PreparedCommand {
  return {
    executable: findWslExe(),
    args: ["--", innerExe, ...innerArgs],
    shell,
    displayCommand,
    wslDistro: distro,
  };
}

/** Resolve a concrete shell executable, including PowerShell 7 and Git Bash on Windows. */
export function resolveShellExecutable(shell: ShellKind): string {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    switch (shell) {
      case "cmd":
        return process.env.ComSpec || findExecutable(["cmd.exe"]) || path.join(systemRoot, "System32", "cmd.exe");
      case "powershell": {
        const found = findExecutable([
          "powershell.exe",
          path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ]);
        if (!found) throw new Error("Windows PowerShell was not found. Install PowerShell or select shell='pwsh'.");
        return found;
      }
      case "pwsh": {
        const found = findExecutable([
          "pwsh.exe",
          path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
          path.join(programFilesX86, "PowerShell", "7", "pwsh.exe"),
        ]);
        if (!found)
          throw new Error("shell='pwsh' was requested, but PowerShell 7 (pwsh.exe) was not found in PATH or its standard install directory.");
        return found;
      }
      case "bash":
      case "sh": {
        const found = findExecutable([
          "bash.exe",
          path.join(programFiles, "Git", "bin", "bash.exe"),
          path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
          path.join(programFilesX86, "Git", "bin", "bash.exe"),
          path.join(programFilesX86, "Git", "usr", "bin", "bash.exe"),
        ]);
        if (!found)
          throw new Error(`shell='${shell}' on Windows requires Git Bash (bash.exe), but it was not found in PATH or a standard Git install directory.`);
        return found;
      }
    }
  }

  switch (shell) {
    case "cmd":
      throw new Error("shell='cmd' is only available on Windows.");
    case "powershell": {
      const found = findExecutable(["powershell", "pwsh"]);
      if (!found) throw new Error("PowerShell was not found in PATH.");
      return found;
    }
    case "pwsh": {
      const found = findExecutable(["pwsh"]);
      if (!found) throw new Error("shell='pwsh' was requested, but pwsh was not found in PATH.");
      return found;
    }
    case "bash": {
      const found = findExecutable(["/bin/bash", "/usr/bin/bash", "bash"]);
      if (!found) throw new Error("bash was not found.");
      return found;
    }
    case "sh": {
      const found = findExecutable(["/bin/sh", "/usr/bin/sh", "sh"]);
      if (!found) throw new Error("/bin/sh was not found.");
      return found;
    }
  }
}

function quoteForDisplay(value: string): string {
  return /[\s"']/u.test(value) ? JSON.stringify(value) : value;
}

export function formatCommandDisplay(request: CommandRequest | string): string {
  const req: CommandRequest = typeof request === "string" ? { command: request } : request;
  if (req.executable) return [req.executable, ...(req.args ?? [])].map(quoteForDisplay).join(" ");
  return String(req.command ?? "");
}

/** Convert a shell command or direct executable+argv request into a spawn invocation. */
export function prepareCommand(
  request: CommandRequest | string,
  explicitShell?: string,
  wslDistro?: string,
): PreparedCommand {
  const req: CommandRequest = typeof request === "string" ? { command: request } : request;
  const executable = String(req.executable ?? "").trim();
  const command = String(req.command ?? "").trim();
  const useWsl = Boolean(wslDistro) && process.platform === "win32" && !wantsWindowsShell(explicitShell);

  if (executable) {
    if (command) throw new Error("Provide either command or executable+args, not both.");
    const args = Array.isArray(req.args) ? req.args.map(String) : [];
    const display = formatCommandDisplay({ executable, args });
    if (useWsl && wslDistro && !isWindowsNativeExecutable(executable)) {
      return wrapWithWsl(wslDistro, executable, args, "direct", display);
    }
    return { executable, args, shell: "direct", displayCommand: display };
  }
  if (!command) throw new Error("command or executable is required");

  if (useWsl && wslDistro) {
    const shell = resolveShell(explicitShell ?? "sh");
    const linuxShell = shell === "bash" ? "/bin/bash" : "/bin/sh";
    return wrapWithWsl(wslDistro, linuxShell, ["-lc", command], shell, command);
  }

  const shell = resolveShell(explicitShell);
  const shellExe = resolveShellExecutable(shell);
  const psUtf8 =
    "$utf8 = New-Object System.Text.UTF8Encoding($false); " +
    "[Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; " +
    "$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'; ";

  if (shell === "cmd") {
    return {
      executable: shellExe,
      args: ["/d", "/s", "/c", `chcp 65001>nul & ${command}`],
      shell,
      displayCommand: command,
    };
  }
  if (shell === "powershell" || shell === "pwsh") {
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive"];
    if (process.platform === "win32") args.push("-ExecutionPolicy", "Bypass");
    args.push("-Command", psUtf8 + command);
    return { executable: shellExe, args, shell, displayCommand: command };
  }
  if (process.platform === "win32") {
    return {
      executable: shellExe,
      args: ["--noprofile", "--norc", "-c", command],
      shell,
      displayCommand: command,
    };
  }
  return { executable: shellExe, args: ["-c", command], shell, displayCommand: command };
}

/** Spawn a prepared command (detached process group on POSIX for tree cleanup). */
export function launchCommand(prepared: PreparedCommand, cwd: string, posixCwd?: string): ChildProcess {
  let executable = prepared.executable;
  let args = prepared.args;
  const spawnCwd = cwd;
  if (prepared.wslDistro && process.platform === "win32") {
    const prefix = ["-d", prepared.wslDistro];
    if (posixCwd) prefix.push("--cd", posixCwd);
    args = [...prefix, ...prepared.args];
  }
  return spawn(executable, args, {
    cwd: spawnCwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Kill a child process and its tree (taskkill on Windows, process group on POSIX). */
export function terminateProcessTree(child: ChildProcess, force: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    if (force) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* fall through */
        }
      }
      child.kill("SIGKILL");
    } else {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          /* fall through */
        }
      }
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

// Foreground output cap before we stop the process (output_limit).
const FOREGROUND_OUTPUT_CAP = 8 * 1024 * 1024;

/** Run a prepared request to completion with a wall-clock timeout and capture. */
export function spawnCommand(
  request: CommandRequest | string,
  cwd: string,
  maxMs: number,
  opts?: SpawnOpts,
): Promise<SpawnCommandResult> {
  return new Promise<SpawnCommandResult>((resolve) => {
    const startedAt = Date.now();
    let prepared: PreparedCommand;
    try {
      prepared = prepareCommand(request, opts?.shell, opts?.wslDistro);
    } catch (e: any) {
      resolve({
        code: -1,
        signal: null,
        stdout: "",
        stderr: String(e?.message ?? e),
        timedOut: false,
        durationMs: 0,
        terminationReason: "spawn_error",
        stdoutTruncated: false,
        stderrTruncated: false,
        shell: "direct",
        executable: "",
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = launchCommand(prepared, cwd, opts?.posixCwd);
    } catch (e: any) {
      resolve({
        code: -1,
        signal: null,
        stdout: "",
        stderr: String(e?.message ?? e),
        timedOut: false,
        durationMs: Date.now() - startedAt,
        terminationReason: "spawn_error",
        stdoutTruncated: false,
        stderrTruncated: false,
        shell: prepared.shell,
        executable: prepared.executable,
      });
      return;
    }

    const stdout = new TextRingBuffer();
    const stderr = new TextRingBuffer();
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let total = 0;
    let settled = false;
    let timedOut = false;
    let terminationReason: TerminationReason = "exit";
    let spawnError: Error | undefined;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: spawnError ? -1 : exitCode,
        signal: spawnError ? null : exitSignal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        durationMs: Date.now() - startedAt,
        terminationReason: spawnError ? "spawn_error" : terminationReason,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        shell: prepared.shell,
        executable: prepared.executable,
      });
    };

    const append = (stream: "stdout" | "stderr", chunk: string) => {
      if (!chunk) return;
      if (stream === "stdout") {
        stdout.append(chunk);
        try {
          opts?.onStdout?.(chunk);
        } catch {
          /* ignore */
        }
      } else {
        stderr.append(chunk);
        try {
          opts?.onStderr?.(chunk);
        } catch {
          /* ignore */
        }
      }
      total += chunk.length;
      if (total > FOREGROUND_OUTPUT_CAP) {
        terminationReason = "output_limit";
        terminateProcessTree(child, true);
      }
    };

    child.stdout?.on("data", (b: Buffer) => append("stdout", stdoutDecoder.write(b)));
    child.stderr?.on("data", (b: Buffer) => append("stderr", stderrDecoder.write(b)));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      append("stdout", stdoutDecoder.end());
      append("stderr", stderrDecoder.end());
      finish();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminationReason = "timeout";
      terminateProcessTree(child, true);
    }, maxMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}
