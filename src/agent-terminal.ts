// Read-only VS Code pseudoterminal that mirrors foreground and background tool I/O.
import * as vscode from "vscode";
import {
  formatCommandDisplay,
  spawnCommand,
  type BackgroundCommandInfo,
  type CommandRequest,
  type SpawnCommandResult,
  type SpawnOpts,
} from "./tool-executor";
import { t } from "./nls";

const DIM = "\x1b[90m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function toCrlf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

class AgentPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private opened = false;

  open(): void {
    this.opened = true;
    this.write(`${DIM}${t("agent.ready")}${RESET}\r\n`);
  }

  close(): void { this.opened = false; }

  write(s: string): void {
    if (this.opened) this.writeEmitter.fire(toCrlf(s));
  }

  handleInput(data: string): void {
    if (data === "\r" || data === "\n") this.write(`${DIM}${t("agent.readonly")}${RESET}\n`);
  }
}

export class AgentTerminalHost implements vscode.Disposable {
  private pty: AgentPty | undefined;
  private terminal: vscode.Terminal | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly isEnabled: () => boolean) {}

  show(): void {
    this.ensureTerminal();
    this.terminal?.show(true);
  }

  dispose(): void {
    this.disposed = true;
    try { this.terminal?.dispose(); } catch { /* ignore */ }
    this.terminal = undefined;
    this.pty = undefined;
  }

  // Foreground commands remain serialized so their output blocks do not interleave.
  async run(request: CommandRequest | string, cwd: string, maxMs: number, opts?: SpawnOpts): Promise<SpawnCommandResult> {
    let result!: SpawnCommandResult;
    const next = this.queue.then(async () => {
      result = await this.runInner(request, cwd, maxMs, opts);
    }, async () => {
      result = await this.runInner(request, cwd, maxMs, opts);
    });
    this.queue = next;
    await next;
    return result;
  }

  backgroundStarted(info: BackgroundCommandInfo): void {
    const pty = this.backgroundPty();
    if (!pty) return;
    const tag = this.shortId(info.commandId);
    pty.write(`\n${YELLOW}[${tag} started pid=${info.pid ?? "?"} shell=${info.shell}]${RESET} ${info.displayCommand}\n`);
  }

  backgroundStdout(commandId: string, chunk: string): void {
    const pty = this.backgroundPty();
    if (pty) pty.write(this.tagChunk(commandId, chunk));
  }

  backgroundStderr(commandId: string, chunk: string): void {
    const pty = this.backgroundPty();
    if (pty) pty.write(`${RED}${this.tagChunk(commandId, chunk)}${RESET}`);
  }

  backgroundExited(info: BackgroundCommandInfo): void {
    const pty = this.backgroundPty();
    if (!pty) return;
    const tag = this.shortId(info.commandId);
    const color = info.status === "exited" && info.exitCode === 0 ? GREEN : RED;
    pty.write(`${DIM}[${color}${tag} ${info.status} exit=${info.exitCode ?? "?"}${RESET}${DIM}]${RESET}\n`);
  }

  private backgroundPty(): AgentPty | undefined {
    if (this.disposed || !this.isEnabled()) return undefined;
    return this.ensureTerminal();
  }

  private shortId(commandId: string): string {
    return commandId.slice(0, 12);
  }

  private tagChunk(commandId: string, chunk: string): string {
    const prefix = `[${this.shortId(commandId)}] `;
    return prefix + chunk.replace(/\n(?!$)/g, `\n${prefix}`);
  }

  private ensureTerminal(): AgentPty {
    if (this.terminal && this.pty && vscode.window.terminals.includes(this.terminal)) return this.pty;
    const pty = new AgentPty();
    this.pty = pty;
    this.terminal = vscode.window.createTerminal({
      name: t("agent.terminalName"),
      pty,
      iconPath: new vscode.ThemeIcon("plug"),
    });
    return pty;
  }

  private async runInner(request: CommandRequest | string, cwd: string, maxMs: number, opts?: SpawnOpts): Promise<SpawnCommandResult> {
    const enabled = !this.disposed && this.isEnabled();
    const pty = enabled ? this.ensureTerminal() : undefined;
    if (enabled) this.terminal?.show(true);
    pty?.write(`\n${CYAN}$ ${formatCommandDisplay(request)}${RESET}\n`);

    const result = await spawnCommand(request, cwd, maxMs, {
      shell: opts?.shell,
      onStdout: (chunk) => pty?.write(chunk),
      onStderr: (chunk) => pty?.write(`${RED}${chunk}${RESET}`),
    });

    if (pty) {
      const label = result.timedOut
        ? t("agent.timeout")
        : result.terminationReason === "output_limit"
          ? "output limit"
          : t("agent.exit", String(result.code ?? "?"));
      const color = result.terminationReason === "exit" && result.code === 0 ? GREEN : RED;
      pty.write(`${DIM}[${color}${label}${RESET}${DIM}]${RESET}\n`);
    }
    return result;
  }
}
