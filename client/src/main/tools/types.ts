/** Tool contract shared by every module in src/main/tools/. */
import type { CommandRunner } from "./spawn";
import type { BackgroundCommandRegistry } from "./background-registry";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// Execution context handed to every tool.
export interface ToolContext {
  workspaceRoot: string;
  resolve(p: string): string;
  commandRunner?: CommandRunner;
  backgroundCommands?: BackgroundCommandRegistry;
  filesBaseUrl?: string;
  maxTransferBytes?: number;
  /** When set, tool work must stop once Date.now() reaches this value. */
  deadlineMs?: number;
  /** Windows+WSL: distro name so commands run via `wsl.exe -d`. */
  wslDistro?: string;
  /** POSIX workspace root inside the WSL distro (`/home/atlas`). */
  posixRoot?: string;
  /** Default shell when the caller does not pass `shell`. */
  defaultShell?: import("./spawn").ShellKind;
  /** Map a host (UNC) absolute path to the POSIX cwd for `wsl.exe --cd`. */
  toPosixCwd?(absHostPath: string): string | undefined;
}

export type ToolHandler = (ctx: ToolContext, args: any) => Promise<ToolCallResult>;

export interface ToolModule extends ToolDescriptor {
  handle: ToolHandler;
}

// Result helpers: plain-text result and error result (MCP content shape).
export const text = (s: string): ToolCallResult => ({ content: [{ type: "text", text: s }] });
export const err = (s: string): ToolCallResult => ({ content: [{ type: "text", text: s }], isError: true });

export const MAX_CAPTURE = 200_000;
