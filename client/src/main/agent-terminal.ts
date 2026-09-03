/**
 * AgentTerminalHost — mirrors foreground/background tool I/O into the app's
 * "Agent Terminal" view (the standalone equivalent of the extension's
 * read-only VS Code pseudoterminal). Foreground commands stay serialized so
 * their output blocks do not interleave.
 */
import { EventEmitter } from "node:events";
import { formatCommandDisplay, spawnCommand, type BackgroundCommandInfo, type CommandRequest, type SpawnCommandResult, type SpawnOpts } from "./tool-executor";
import type { TerminalLine } from "../shared/ipc";

function shortId(commandId: string): string {
  return commandId.slice(0, 12);
}

export class AgentTerminalHost {
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly events = new EventEmitter();

  constructor(private readonly isEnabled: () => boolean) {}

  onLine(fn: (line: TerminalLine) => void): () => void {
    const handler = (line: TerminalLine) => fn(line);
    this.events.on("line", handler);
    return () => {
      this.events.off("line", handler);
    };
  }

  private emit(line: TerminalLine): void {
    try {
      this.events.emit("line", line);
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.events.removeAllListeners();
  }

  // Foreground commands remain serialized so their output blocks do not interleave.
  async run(request: CommandRequest | string, cwd: string, maxMs: number, opts?: SpawnOpts): Promise<SpawnCommandResult> {
    let result!: SpawnCommandResult;
    const next = this.queue.then(
      async () => {
        result = await this.runInner(request, cwd, maxMs, opts);
      },
      async () => {
        result = await this.runInner(request, cwd, maxMs, opts);
      },
    );
    this.queue = next;
    await next;
    return result;
  }

  backgroundStarted(info: BackgroundCommandInfo): void {
    if (this.disposed || !this.isEnabled()) return;
    const tag = shortId(info.commandId);
    this.emit({ kind: "info", text: `\n[${tag} started pid=${info.pid ?? "?"} shell=${info.shell}] ${info.displayCommand}\n` });
    if (info.logFile) {
      this.emit({ kind: "info", text: `  log:  ${info.logFile}\n` });
      this.emit({ kind: "info", text: `  tail: Get-Content -Wait -Tail 50 "${info.logFile}"\n` });
    }
  }

  // Background stdout/stderr are intentionally NOT mirrored into the shared
  // terminal (they would interleave); each task's full output lives in its own
  // log file and is available via read_command.
  backgroundStdout(_commandId: string, _chunk: string): void {
    /* no-op */
  }

  backgroundStderr(_commandId: string, _chunk: string): void {
    /* no-op */
  }

  backgroundExited(info: BackgroundCommandInfo): void {
    if (this.disposed || !this.isEnabled()) return;
    const tag = shortId(info.commandId);
    const ok = info.status === "exited" && info.exitCode === 0;
    const logHint = info.logFile ? ` (log: ${info.logFile})` : "";
    this.emit({ kind: ok ? "ok" : "fail", text: `[${tag} ${info.status} exit=${info.exitCode ?? "?"}]${logHint}\n` });
  }

  private async runInner(request: CommandRequest | string, cwd: string, maxMs: number, opts?: SpawnOpts): Promise<SpawnCommandResult> {
    const enabled = !this.disposed && this.isEnabled();
    if (enabled) this.emit({ kind: "info", text: `$ ${formatCommandDisplay(request)}\n` });

    const result = await spawnCommand(request, cwd, maxMs, {
      ...opts,
      onStdout: (chunk) => {
        if (enabled) this.emit({ kind: "out", text: chunk });
      },
      onStderr: (chunk) => {
        if (enabled) this.emit({ kind: "err", text: chunk });
      },
    });

    if (enabled) {
      const label = result.timedOut
        ? "timeout"
        : result.terminationReason === "output_limit"
          ? "output limit"
          : `exit ${result.code ?? "?"}`;
      const ok = result.terminationReason === "exit" && result.code === 0;
      this.emit({ kind: ok ? "ok" : "fail", text: `[${label}]\n` });
    }
    return result;
  }
}
