// Compatibility barrel. Implementations live in src/tools/.
export {
  ToolExecutor,
  spawnCommand,
  resolveShell,
  formatCommandDisplay,
} from "./tools";
export type {
  ToolDescriptor,
  ToolCallResult,
  ToolContext,
  ToolModule,
  CommandRunner,
  CommandRequest,
  CommandMode,
  ShellKind,
  SpawnOpts,
  SpawnCommandResult,
  TerminationReason,
  BackgroundCommandHooks,
  BackgroundCommandInfo,
  BackgroundStatus,
} from "./tools";
