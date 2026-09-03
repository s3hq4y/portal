// MCP tool registry. Portal is deliberately minimal: commands + file transfer.
import * as nodePath from "node:path";
import { err, ToolCallResult, ToolContext, ToolDescriptor, ToolModule } from "./types";
import { hostPathToPosix, resolveInWorkspace } from "./workspace";
import type { CommandRunner, ShellKind } from "./spawn";
import { BackgroundCommandRegistry, type BackgroundCommandHooks } from "./background-registry";
import { runCommand } from "./run-command";
import { startCommand, readCommand, stopCommand } from "./background-command";
import { fileTransferInfo } from "./file-transfer-info";

export type { ToolDescriptor, ToolCallResult, ToolContext, ToolModule } from "./types";
export type {
  CommandRunner,
  CommandRequest,
  CommandMode,
  ShellKind,
  SpawnOpts,
  SpawnCommandResult,
  TerminationReason,
} from "./spawn";
export type { BackgroundCommandHooks, BackgroundCommandInfo, BackgroundStatus } from "./background-registry";
export { spawnCommand, resolveShell, formatCommandDisplay } from "./spawn";

// Single source of truth for the exposed MCP tools (5 total).
const allTools: ToolModule[] = [runCommand, startCommand, readCommand, stopCommand, fileTransferInfo];

const byName = new Map(allTools.map((tool) => [tool.name, tool]));

export class ToolExecutor {
  private readonly ctx: ToolContext;
  private readonly backgroundCommands: BackgroundCommandRegistry;

  constructor(
    workspaceRoot: string,
    commandRunner?: CommandRunner,
    backgroundHooks?: BackgroundCommandHooks,
    env?: { wslDistro?: string; posixRoot?: string; defaultShell?: ShellKind },
  ) {
    const joinPath =
      workspaceRoot.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(workspaceRoot)
        ? nodePath.win32.join
        : nodePath.posix.join;
    const logDir = joinPath(workspaceRoot, ".portal", "logs");
    this.backgroundCommands = new BackgroundCommandRegistry(backgroundHooks, { logDir });
    const posixRoot = env?.posixRoot;
    this.ctx = {
      workspaceRoot,
      resolve: (p: string) => resolveInWorkspace(workspaceRoot, p),
      commandRunner,
      backgroundCommands: this.backgroundCommands,
      wslDistro: env?.wslDistro,
      posixRoot,
      defaultShell: env?.defaultShell,
      toPosixCwd: posixRoot ? (abs) => hostPathToPosix(workspaceRoot, posixRoot, abs) : undefined,
    };
  }

  setTransferInfo(info: { filesBaseUrl?: string; maxTransferBytes?: number }): void {
    if (info.filesBaseUrl !== undefined) this.ctx.filesBaseUrl = info.filesBaseUrl;
    if (info.maxTransferBytes !== undefined) this.ctx.maxTransferBytes = info.maxTransferBytes;
  }

  listTools(): ToolDescriptor[] {
    return allTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  // Dispatch by name; tool exceptions become isError results, never HTTP 500s.
  async callTool(name: string, args: any): Promise<ToolCallResult> {
    const tool = byName.get(name);
    if (!tool) return err(`Unknown tool: ${name}`);
    try {
      return await tool.handle(this.ctx, args);
    } catch (e: any) {
      return err(`${name} failed: ${e?.message ?? String(e)}`);
    }
  }

  /** Stop all child processes owned by this executor. Safe to call more than once. */
  async dispose(): Promise<void> {
    await this.backgroundCommands.dispose();
  }
}
