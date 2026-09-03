/** start_command / read_command / stop_command — long-running job management. */
import { err, text, ToolModule } from "./types";
import { clampNumber, parseCommandRequest, parseShell } from "./command-input";

export const startCommand: ToolModule = {
  name: "start_command",
  description:
    "Start a long-running command and return immediately with command_id, PID, and log_file. Up to four commands may run concurrently. Each command streams its full stdout/stderr to its OWN log file (returned as log_file, under .portal/logs/) so tasks can be observed independently. Use read_command with returned offsets, then stop_command when finished.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command line. Mutually exclusive with executable." },
      executable: { type: "string", description: "Executable for direct argv mode. Mutually exclusive with command." },
      args: { type: "array", items: { type: "string" }, description: "Arguments used only with executable." },
      cwd: { type: "string", description: "Workspace-relative working directory (default: workspace root)." },
      shell: { type: "string", enum: ["powershell", "pwsh", "cmd", "sh", "bash"] },
      max_duration_ms: { type: "number", minimum: 1000, maximum: 600000, description: "Timeout in milliseconds (default 120000; maximum 600000)." },
    },
    oneOf: [{ required: ["command"] }, { required: ["executable"] }],
  },
  async handle(ctx, args) {
    const reg = ctx.backgroundCommands;
    if (!reg) return err("Background commands are not available.");
    const request = parseCommandRequest(args);
    const shell = parseShell(args?.shell) ?? ctx.defaultShell;
    const maxMs = clampNumber(args?.max_duration_ms, 120_000, 1_000, 600_000);
    const cwd = ctx.resolve(String(args?.cwd ?? "."));
    const info = await reg.start(request, cwd, maxMs, {
      shell,
      wslDistro: ctx.wslDistro,
      posixCwd: ctx.toPosixCwd?.(cwd),
    });
    return text(JSON.stringify(info, null, 2));
  },
};

export const readCommand: ToolModule = {
  name: "read_command",
  description:
    "Read incremental stdout/stderr and status for a background command. Pass next_offset values into the next call. Omit command_id to list retained jobs. Completed records expire after 10 minutes.",
  inputSchema: {
    type: "object",
    properties: {
      command_id: { type: "string", description: "The command_id returned by start_command. Omit to list all retained jobs." },
      stdout_offset: { type: "number", description: "Start reading stdout at this offset (default: beginning)." },
      stderr_offset: { type: "number", description: "Start reading stderr at this offset (default: beginning)." },
      max_chars: { type: "number", description: "Maximum characters to return per stream (default 20000, max 200000)." },
      wait_ms: { type: "number", minimum: 0, maximum: 30000, description: "When the command is still running and there is no new output, wait up to this many ms before returning (default 0)." },
    },
  },
  async handle(ctx, args) {
    const reg = ctx.backgroundCommands;
    if (!reg) return err("Background commands are not available.");
    const commandId = typeof args?.command_id === "string" ? args.command_id.trim() : "";
    if (!commandId) {
      const list = reg.list();
      if (!list.length) return text("No background commands. (none retained)");
      return text(list.map((i) => JSON.stringify(i)).join("\n"));
    }
    const stdoutOffset = toOffset(args?.stdout_offset);
    const stderrOffset = toOffset(args?.stderr_offset);
    const maxChars = clampNumber(args?.max_chars, 20_000, 1, 200_000);
    const waitMs = clampNumber(args?.wait_ms, 0, 0, 30_000);
    const result = await reg.read(commandId, stdoutOffset, stderrOffset, maxChars, waitMs);
    return text(JSON.stringify(result, null, 2));
  },
};

export const stopCommand: ToolModule = {
  name: "stop_command",
  description:
    "Stop a running background command and its process tree. A graceful request is escalated after two seconds; force=true requests immediate forceful termination.",
  inputSchema: {
    type: "object",
    properties: {
      command_id: { type: "string" },
      force: { type: "boolean", description: "Immediately force-kill instead of a graceful stop (default false)." },
    },
    required: ["command_id"],
  },
  async handle(ctx, args) {
    const reg = ctx.backgroundCommands;
    if (!reg) return err("Background commands are not available.");
    const commandId = String(args?.command_id ?? "").trim();
    if (!commandId) return err("command_id is required.");
    const info = await reg.stop(commandId, Boolean(args?.force));
    return text(JSON.stringify(info, null, 2));
  },
};

function toOffset(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}
