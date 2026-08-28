/** In-memory registry for long-running commands exposed by start/read/stop tools. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  launchCommand,
  prepareCommand,
  terminateProcessTree,
  type CommandMode,
  type CommandRequest,
  type ShellKind,
  type TerminationReason,
} from "./spawn";

const MAX_CONCURRENT = 4;
const OUTPUT_BUFFER_CHARS = 200_000;
const COMPLETED_RETENTION_MS = 10 * 60_000;

export type BackgroundStatus = "running" | "exited" | "failed" | "timed_out" | "stopped";

export interface BackgroundCommandInfo {
  commandId: string;
  pid: number | null;
  status: BackgroundStatus;
  displayCommand: string;
  cwd: string;
  shell: CommandMode;
  executable: string;
  startedAt: number;
  endedAt?: number;
  maxDurationMs: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  terminationReason?: TerminationReason;
  /** Absolute path of the per-command log file (each task gets its own). */
  logFile?: string;
}

export interface BackgroundCommandHooks {
  onStart?: (info: BackgroundCommandInfo) => void;
  onStdout?: (commandId: string, chunk: string) => void;
  onStderr?: (commandId: string, chunk: string) => void;
  onExit?: (info: BackgroundCommandInfo) => void;
}

export interface BackgroundRegistryOptions {
  /** Directory where per-command log files are written (one file per task). */
  logDir?: string;
}

interface BufferRead {
  text: string;
  oldestOffset: number;
  startOffset: number;
  nextOffset: number;
  endOffset: number;
  truncatedBefore: boolean;
  hasMore: boolean;
}

class TextRingBuffer {
  private value = "";
  private baseOffset = 0;

  append(chunk: string): void {
    if (!chunk) return;
    this.value += chunk;
    if (this.value.length > OUTPUT_BUFFER_CHARS) {
      const drop = this.value.length - OUTPUT_BUFFER_CHARS;
      this.value = this.value.slice(drop);
      this.baseOffset += drop;
    }
  }

  get oldestOffset(): number { return this.baseOffset; }
  get endOffset(): number { return this.baseOffset + this.value.length; }

  read(requestedOffset: number | undefined, maxChars: number): BufferRead {
    const requested = requestedOffset == null ? this.baseOffset : Math.max(0, Math.floor(requestedOffset));
    const startOffset = Math.min(Math.max(requested, this.baseOffset), this.endOffset);
    const relativeStart = startOffset - this.baseOffset;
    const text = this.value.slice(relativeStart, relativeStart + maxChars);
    const nextOffset = startOffset + text.length;
    return {
      text,
      oldestOffset: this.baseOffset,
      startOffset,
      nextOffset,
      endOffset: this.endOffset,
      truncatedBefore: requested < this.baseOffset,
      hasMore: nextOffset < this.endOffset,
    };
  }
}

interface RegistryEntry extends BackgroundCommandInfo {
  child: ChildProcess;
  stdout: TextRingBuffer;
  stderr: TextRingBuffer;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  timeoutTimer?: NodeJS.Timeout;
  forceTimer?: NodeJS.Timeout;
  requestedReason?: "timeout" | "stopped";
  settled: boolean;
  changeWaiters: Set<() => void>;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  logStream?: fs.WriteStream;
}

export interface BackgroundReadResult {
  command: BackgroundCommandInfo;
  stdout: BufferRead;
  stderr: BufferRead;
}

export class BackgroundCommandRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private disposed = false;
  private readonly logDir?: string;

  constructor(private readonly hooks?: BackgroundCommandHooks, options?: BackgroundRegistryOptions) {
    this.logDir = options?.logDir;
  }

  start(
    request: CommandRequest,
    cwd: string,
    shell: ShellKind | undefined,
    maxDurationMs: number,
    target?: { wslDistro?: string; posixCwd?: string },
  ): BackgroundCommandInfo {
    if (this.disposed) throw new Error("Background command registry is shutting down.");
    this.cleanupExpired();
    const running = [...this.entries.values()].filter((entry) => entry.status === "running").length;
    if (running >= MAX_CONCURRENT) {
      throw new Error(`Background command limit reached (${MAX_CONCURRENT}). Stop or wait for an existing command before starting another.`);
    }

    const prepared = prepareCommand(request, shell, target?.wslDistro);
    const child = launchCommand(prepared, cwd, target?.posixCwd);
    const commandId = `cmd-${randomUUID()}`;
    const logFile = this.openLogFile(commandId, prepared.displayCommand);
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
    const entry: RegistryEntry = {
      commandId,
      pid: child.pid ?? null,
      status: "running",
      displayCommand: prepared.displayCommand,
      cwd,
      shell: prepared.shell,
      executable: prepared.executable,
      startedAt: Date.now(),
      maxDurationMs,
      logFile: logFile?.path,
      logStream: logFile?.stream,
      child,
      stdout: new TextRingBuffer(),
      stderr: new TextRingBuffer(),
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      settled: false,
      changeWaiters: new Set(),
      exitPromise,
      resolveExit,
    };
    this.entries.set(commandId, entry);

    // Per-task log header so a fresh `Get-Content -Wait` tail is self-describing.
    this.writeLog(entry,
      `# Portal background command log\n` +
      `# command_id : ${commandId}\n` +
      `# pid        : ${entry.pid ?? "?"}\n` +
      `# shell      : ${entry.shell}\n` +
      `# cwd        : ${cwd}\n` +
      `# command    : ${prepared.displayCommand}\n` +
      `# started    : ${new Date(entry.startedAt).toISOString()}\n` +
      `# ----------------------------------------------------------------\n`);

    const append = (stream: "stdout" | "stderr", chunk: string) => {
      if (!chunk) return;
      entry[stream].append(chunk);
      // Mirror the raw stream into this task's own log file (stdout + stderr
      // interleaved, exactly as a dedicated terminal would show them).
      this.writeLog(entry, chunk);
      try {
        if (stream === "stdout") this.hooks?.onStdout?.(commandId, chunk);
        else this.hooks?.onStderr?.(commandId, chunk);
      } catch { /* observers cannot break process tracking */ }
      this.signalChange(entry);
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      if (entry.forceTimer) clearTimeout(entry.forceTimer);
      append("stdout", entry.stdoutDecoder.end());
      append("stderr", entry.stderrDecoder.end());
      if (spawnError) append("stderr", `spawn error: ${spawnError.message}\n`);
      entry.endedAt = Date.now();
      entry.exitCode = spawnError ? -1 : code;
      entry.signal = signal;
      if (spawnError) {
        entry.status = "failed";
        entry.terminationReason = "spawn_error";
      } else if (entry.requestedReason === "timeout") {
        entry.status = "timed_out";
        entry.terminationReason = "timeout";
      } else if (entry.requestedReason === "stopped") {
        entry.status = "stopped";
        entry.terminationReason = "stopped";
      } else {
        entry.status = code === 0 ? "exited" : "failed";
        entry.terminationReason = "exit";
      }
      // Per-task log footer, then close the file handle.
      this.writeLog(entry,
        `\n# ----------------------------------------------------------------\n` +
        `# status     : ${entry.status}\n` +
        `# exit_code  : ${entry.exitCode ?? "?"}\n` +
        `# signal     : ${entry.signal ?? "-"}\n` +
        `# ended      : ${new Date(entry.endedAt).toISOString()}\n`);
      this.closeLog(entry);
      this.signalChange(entry);
      entry.resolveExit();
      try { this.hooks?.onExit?.(this.info(entry)); } catch { /* ignore */ }
    };

    child.stdout?.on("data", (b: Buffer) => append("stdout", entry.stdoutDecoder.write(b)));
    child.stderr?.on("data", (b: Buffer) => append("stderr", entry.stderrDecoder.write(b)));
    child.on("error", (error) => finish(-1, null, error));
    child.on("close", (code, signal) => finish(code, signal));
    entry.timeoutTimer = setTimeout(() => this.requestTermination(entry, "timeout", false), maxDurationMs);
    entry.timeoutTimer.unref?.();

    try { this.hooks?.onStart?.(this.info(entry)); } catch { /* ignore */ }
    return this.info(entry);
  }

  async read(
    commandId: string,
    stdoutOffset: number | undefined,
    stderrOffset: number | undefined,
    maxChars: number,
    waitMs: number,
  ): Promise<BackgroundReadResult> {
    this.cleanupExpired();
    const entry = this.require(commandId);
    const noUnreadOutput = (stdoutOffset ?? entry.stdout.oldestOffset) >= entry.stdout.endOffset
      && (stderrOffset ?? entry.stderr.oldestOffset) >= entry.stderr.endOffset;
    if (waitMs > 0 && entry.status === "running" && noUnreadOutput) {
      await this.waitForChange(entry, waitMs);
    }
    return {
      command: this.info(entry),
      stdout: entry.stdout.read(stdoutOffset, maxChars),
      stderr: entry.stderr.read(stderrOffset, maxChars),
    };
  }

  async stop(commandId: string, force: boolean): Promise<BackgroundCommandInfo> {
    this.cleanupExpired();
    const entry = this.require(commandId);
    if (entry.status !== "running") return this.info(entry);
    this.requestTermination(entry, "stopped", force);
    await Promise.race([
      entry.exitPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, force ? 2_000 : 5_000);
        timer.unref?.();
      }),
    ]);
    return this.info(entry);
  }

  list(): BackgroundCommandInfo[] {
    this.cleanupExpired();
    return [...this.entries.values()].map((entry) => this.info(entry));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const running = [...this.entries.values()].filter((entry) => entry.status === "running");
    for (const entry of running) this.requestTermination(entry, "stopped", true);
    await Promise.all(running.map((entry) => Promise.race([
      entry.exitPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ])));
    for (const entry of this.entries.values()) this.closeLog(entry);
    this.entries.clear();
  }

  // --- per-task log file helpers -------------------------------------------

  // Open (create) a dedicated log file for one background command. Failures are
  // swallowed: logging must never prevent a command from running.
  private openLogFile(commandId: string, displayCommand: string): { path: string; stream: fs.WriteStream } | undefined {
    if (!this.logDir) return undefined;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const now = new Date();
      const ts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      ].join("") + "-" + [
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");
      const slug = displayCommand.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "command";
      const shortId = commandId.replace(/^cmd-/, "").slice(0, 8);
      const filename = `${ts}-${slug}-${shortId}.log`;
      const path = nodePath.join(this.logDir, filename);
      const stream = fs.createWriteStream(path, { flags: "a" });
      stream.on("error", () => { /* disk full / permissions: ignore */ });
      return { path, stream };
    } catch {
      return undefined;
    }
  }

  private writeLog(entry: RegistryEntry, chunk: string): void {
    if (!entry.logStream || !chunk) return;
    try { entry.logStream.write(chunk); } catch { /* ignore */ }
  }

  private closeLog(entry: RegistryEntry): void {
    if (!entry.logStream) return;
    try { entry.logStream.end(); } catch { /* ignore */ }
    entry.logStream = undefined;
  }

  private requestTermination(entry: RegistryEntry, reason: "timeout" | "stopped", force: boolean): void {
    if (entry.status !== "running" || entry.requestedReason) return;
    entry.requestedReason = reason;
    terminateProcessTree(entry.child, force);
    if (!force) {
      entry.forceTimer = setTimeout(() => terminateProcessTree(entry.child, true), 2_000);
      entry.forceTimer.unref?.();
    }
    this.signalChange(entry);
  }

  private info(entry: RegistryEntry): BackgroundCommandInfo {
    return {
      commandId: entry.commandId,
      pid: entry.pid,
      status: entry.status,
      displayCommand: entry.displayCommand,
      cwd: entry.cwd,
      shell: entry.shell,
      executable: entry.executable,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      maxDurationMs: entry.maxDurationMs,
      exitCode: entry.exitCode,
      signal: entry.signal,
      terminationReason: entry.terminationReason,
      logFile: entry.logFile,
    };
  }

  private require(commandId: string): RegistryEntry {
    const entry = this.entries.get(commandId);
    if (!entry) throw new Error(`Unknown or expired command_id: ${commandId}`);
    return entry;
  }

  private signalChange(entry: RegistryEntry): void {
    for (const resolve of entry.changeWaiters) resolve();
    entry.changeWaiters.clear();
  }

  private waitForChange(entry: RegistryEntry, waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.changeWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref?.();
      entry.changeWaiters.add(done);
    });
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.endedAt && now - entry.endedAt > COMPLETED_RETENTION_MS) this.entries.delete(id);
    }
  }
}
