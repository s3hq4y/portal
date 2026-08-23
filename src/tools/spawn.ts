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
}

// Map user-friendly aliases to a shell kind. Explicit pwsh and bash selections
// remain distinct so they launch the requested executable rather than silently
// falling back to Windows PowerShell or /bin/sh.
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
        if (!found) throw new Error("shell='pwsh' was requested, but PowerShell 7 (pwsh.exe) was not found in PATH or its standard install directory.");
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
        if (!found) throw new Error(`shell='${shell}' on Windows requires Git Bash (bash.exe), but it was not found in PATH or a standard Git install directory.`);
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
export function prepareCommand(request: CommandRequest | string, explicitShell?: string): PreparedCommand {
  const req: CommandRequest = typeof request === "string" ? { command: request } : request;
  const executable = String(req.executable ?? "").trim();
  const command = String(req.command ?? "").trim();

  if (executable) {
    if (command) throw new Error("Provide either command or executable+args, not both.");
    const args = Array.isArray(req.args) ? req.args.map(String) : [];
    return { executable, args, shell: "direct", displayCommand: formatCommandDisplay({ executable, args }) };
  }
  if (!command) throw new Error("command or executable is required");

  const shell = resolveShell(explicitShell);
  const shellExe = resolveShellExecutable(shell);
  const psUtf8 = "$utf8 = New-Object System.Text.UTF8Encoding($false); "
    + "[Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; "
    + "$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'; ";

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

/** Spawn a prepared command in its own POSIX process group for tree cleanup. */
export function launchCommand(prepared: PreparedCommand, cwd: string): ChildProcess {
  return spawn(prepared.executable, prepared.args, {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
}

/** Best-effort whole-process-tree termination. */
export function terminateProcessTree(child: ChildProcess, force = false): void {
  const pid = child.pid;
  if (!pid) {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* ignore */ }
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => { try { child.kill(); } catch { /* ignore */ } });
      killer.unref();
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* ignore */ }
  }
}

export function spawnCommand(
  request: CommandRequest | string,
  cwd: string,
  maxMs: number,
  hooks?: SpawnOpts,
): Promise<SpawnCommandResult> {
  const prepared = prepareCommand(request, hooks?.shell);
  const startedAt = Date.now();
  const child = launchCommand(prepared, cwd);

  return new Promise<SpawnCommandResult>((resolve) => {
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let requestedReason: TerminationReason | undefined;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: TerminationReason) => {
      if (requestedReason) return;
      requestedReason = reason;
      terminateProcessTree(child, false);
      forceTimer = setTimeout(() => terminateProcessTree(child, true), 2_000);
      forceTimer.unref?.();
    };

    const append = (stream: "stdout" | "stderr", chunk: string) => {
      try { stream === "stdout" ? hooks?.onStdout?.(chunk) : hooks?.onStderr?.(chunk); } catch { /* observer errors are non-fatal */ }
      if (stream === "stdout") {
        const room = Math.max(0, MAX_CAPTURE - stdout.length);
        if (chunk.length > room) stdoutTruncated = true;
        stdout += chunk.slice(0, room);
      } else {
        const room = Math.max(0, MAX_CAPTURE - stderr.length);
        if (chunk.length > room) stderrTruncated = true;
        stderr += chunk.slice(0, room);
      }
      if (stdoutTruncated || stderrTruncated) terminate("output_limit");
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail) append("stdout", stdoutTail);
      if (stderrTail) append("stderr", stderrTail);
      if (spawnError) {
        const msg = `spawn error: ${spawnError.message}\n`;
        append("stderr", msg);
      }
      const reason: TerminationReason = spawnError ? "spawn_error" : (requestedReason ?? "exit");
      resolve({
        code: spawnError ? -1 : code,
        signal,
        stdout,
        stderr,
        timedOut: reason === "timeout",
        durationMs: Date.now() - startedAt,
        terminationReason: reason,
        stdoutTruncated,
        stderrTruncated,
        shell: prepared.shell,
        executable: prepared.executable,
      });
    };

    const timeoutTimer = setTimeout(() => terminate("timeout"), maxMs);
    child.stdout?.on("data", (b: Buffer) => append("stdout", stdoutDecoder.write(b)));
    child.stderr?.on("data", (b: Buffer) => append("stderr", stderrDecoder.write(b)));
    child.on("error", (e) => finish(-1, null, e));
    child.on("close", (code, signal) => finish(code, signal));
  });
}
