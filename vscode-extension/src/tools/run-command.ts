/** run_command: bounded foreground execution with terminal mirroring. */
import { err, text, ToolModule } from "./types";
import { clampNumber, parseCommandRequest, parseShell } from "./command-input";
import { spawnCommand } from "./spawn";
import { relToWorkspace } from "./workspace";

export const runCommand: ToolModule = {
  name: "run_command",
  description: "Run a foreground command inside the workspace. Default timeout is 120 seconds. Use command+shell for shell syntax, or executable+args for injection-safe direct argv execution. Windows supports powershell, pwsh, cmd, and Git Bash (bash/sh). Output is mirrored to the VS Code 'Portal Agent' terminal and the result starts with structured metadata.",
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
    oneOf: [
      { required: ["command"] },
      { required: ["executable"] },
    ],
  },
  async handle(ctx, args) {
    const request = parseCommandRequest(args);
    const shell = parseShell(args?.shell) ?? ctx.defaultShell;
    const maxMs = clampNumber(args?.max_duration_ms, 120_000, 1_000, 600_000);
    const cwd = ctx.resolve(String(args?.cwd ?? "."));
    const runner = ctx.commandRunner ?? spawnCommand;
    const result = await runner(request, cwd, maxMs, {
      shell,
      wslDistro: ctx.wslDistro,
      posixCwd: ctx.toPosixCwd?.(cwd),
    });
    const metadata = {
      cwd: relToWorkspace(ctx.workspaceRoot, cwd),
      shell: result.shell,
      executable: result.executable,
      exit_code: result.code,
      signal: result.signal,
      duration_ms: result.durationMs,
      max_duration_ms: maxMs,
      timed_out: result.timedOut,
      termination_reason: result.terminationReason,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
    };
    const stdout = result.stdout + (result.stdoutTruncated ? "\n[stdout truncated at capture limit]" : "");
    const stderr = result.stderr + (result.stderrTruncated ? "\n[stderr truncated at capture limit]" : "");
    const body = `metadata:\n${JSON.stringify(metadata, null, 2)}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    const ok = result.code === 0 && result.terminationReason === "exit";
    return ok ? text(body) : err(body);
  },
};
