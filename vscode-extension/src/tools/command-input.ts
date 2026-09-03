import type { CommandRequest, ShellKind } from "./spawn";

export function parseCommandRequest(args: any): CommandRequest {
  const command = typeof args?.command === "string" ? args.command.trim() : "";
  const executable = typeof args?.executable === "string" ? args.executable.trim() : "";
  if (!!command === !!executable) {
    throw new Error("Provide exactly one of command or executable.");
  }
  if (executable) {
    if (args?.shell != null) throw new Error("shell cannot be combined with executable+args mode.");
    if (args?.args != null && !Array.isArray(args.args)) throw new Error("args must be an array of strings.");
    const argv = (args?.args ?? []).map((value: unknown) => {
      if (typeof value !== "string") throw new Error("Every args entry must be a string.");
      return value;
    });
    return { executable, args: argv };
  }
  return { command };
}

export function parseShell(value: unknown): ShellKind | undefined {
  if (value == null || value === "") return undefined;
  const shell = String(value) as ShellKind;
  if (!["powershell", "pwsh", "cmd", "sh", "bash"].includes(shell)) {
    throw new Error(`Unsupported shell: ${String(value)}`);
  }
  return shell;
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(min, Math.floor(parsed)), max);
}
