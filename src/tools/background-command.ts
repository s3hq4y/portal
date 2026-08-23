/** start_command/read_command/stop_command tools for long-running processes. */
import { text, type ToolContext, type ToolModule } from "./types";
import { clampNumber, parseCommandRequest, parseShell } from "./command-input";
import type { BackgroundCommandInfo, BackgroundReadResult } from "./background-registry";
import { relToWorkspace } from "./workspace";

function publicInfo(ctx: ToolContext, info: BackgroundCommandInfo): Record<string, unknown> {
  return {
    command_id: info.commandId,
    pid: info.pid,
    status: info.status,
    command: info.displayCommand,
    cwd: relToWorkspace(ctx.workspaceRoot, info.cwd),
    shell: info.shell,
    executable: info.executable,
    started_at: new Date(info.startedAt).toISOString(),
    ended_at: info.endedAt == null ? undefined : new Date(info.endedAt).toISOString(),
    max_duration_ms: info.maxDurationMs,
    exit_code: info.exitCode,
    signal: info.signal,
    termination_reason: info.terminationReason,
  };
}

function publicRead(ctx: ToolContext, result: BackgroundReadResult): Record<string, unknown> {
  const output = (part: BackgroundReadResult["stdout"]) => ({
    text: part.text,
    oldest_offset: part.oldestOffset,
    start_offset: part.startOffset,
    next_offset: part.nextOffset,
    end_offset: part.endOffset,
    truncated_before: part.truncatedBefore,
    has_more: part.hasMore,
  });
  return {
    command: publicInfo(ctx, result.command),
    stdout: output(result.stdout),
    stderr: output(result.stderr),
  };
}

const commandProperties = {
  command: { type: "string", description: "Shell command line. Mutually exclusive with executable." },
  executable: { type: "string", description: "Executable for direct argv mode. Mutually exclusive with command." },
  args: { type: "array", items: { type: "string" }, description: "Arguments used only with executable." },
  cwd: { type: "string", description: "Workspace-relative working directory (default: workspace root)." },
  shell: { type: "string", enum: ["powershell", "pwsh", "cmd", "sh", "bash"] },
  max_duration_ms: { type: "number", minimum: 1000, maximum: 86400000, description: "Maximum lifetime (default 3600000; maximum 24 hours)." },
};

export const startCommand: ToolModule = {
  name: "start_command",
  description: "Start a long-running command and return immediately with command_id and PID. Up to four commands may run concurrently. Output is kept in bounded ring buffers and mirrored to the Portal Agent terminal. Use read_command with returned offsets, then stop_command when finished.",
  inputSchema: {
    type: "object",
    properties: commandProperties,
    oneOf: [
      { required: ["command"] },
      { required: ["executable"] },
    ],
  },
  async handle(ctx, args) {
    if (!ctx.backgroundCommands) throw new Error("Background command support is unavailable.");
    const request = parseCommandRequest(args);
    const shell = parseShell(args?.shell);
    const cwd = ctx.resolve(String(args?.cwd ?? "."));
    const maxMs = clampNumber(args?.max_duration_ms, 3_600_000, 1_000, 86_400_000);
    const info = ctx.backgroundCommands.start(request, cwd, shell, maxMs);
    return text(JSON.stringify(publicInfo(ctx, info), null, 2));
  },
};

export const readCommand: ToolModule = {
  name: "read_command",
  description: "Read incremental stdout/stderr and status for a background command. Pass next_offset values into the next call. Output older than the 200,000-character per-stream ring buffer is marked truncated. Omit command_id to list retained commands; completed records expire after 10 minutes.",
  inputSchema: {
    type: "object",
    properties: {
      command_id: { type: "string" },
      stdout_offset: { type: "number", minimum: 0 },
      stderr_offset: { type: "number", minimum: 0 },
      max_chars: { type: "number", minimum: 1000, maximum: 100000, description: "Maximum characters returned per stream (default 64000)." },
      wait_ms: { type: "number", minimum: 0, maximum: 30000, description: "Long-poll while running when no unread output is available." },
    },
  },
  async handle(ctx, args) {
    if (!ctx.backgroundCommands) throw new Error("Background command support is unavailable.");
    const commandId = String(args?.command_id ?? "").trim();
    if (!commandId) {
      return text(JSON.stringify({ commands: ctx.backgroundCommands.list().map((info) => publicInfo(ctx, info)) }, null, 2));
    }
    const stdoutOffset = args?.stdout_offset == null ? undefined : Math.max(0, Math.floor(Number(args.stdout_offset)) || 0);
    const stderrOffset = args?.stderr_offset == null ? undefined : Math.max(0, Math.floor(Number(args.stderr_offset)) || 0);
    const maxChars = clampNumber(args?.max_chars, 64_000, 1_000, 100_000);
    const waitMs = clampNumber(args?.wait_ms, 0, 0, 30_000);
    const result = await ctx.backgroundCommands.read(commandId, stdoutOffset, stderrOffset, maxChars, waitMs);
    return text(JSON.stringify(publicRead(ctx, result), null, 2));
  },
};

export const stopCommand: ToolModule = {
  name: "stop_command",
  description: "Stop a running background command and its process tree. A graceful request is escalated after two seconds; force=true requests immediate forceful termination. The final buffered output remains readable for 10 minutes.",
  inputSchema: {
    type: "object",
    properties: {
      command_id: { type: "string" },
      force: { type: "boolean" },
    },
    required: ["command_id"],
  },
  async handle(ctx, args) {
    if (!ctx.backgroundCommands) throw new Error("Background command support is unavailable.");
    const commandId = String(args?.command_id ?? "").trim();
    if (!commandId) throw new Error("command_id is required");
    const info = await ctx.backgroundCommands.stop(commandId, !!args?.force);
    return text(JSON.stringify(publicInfo(ctx, info), null, 2));
  },
};
