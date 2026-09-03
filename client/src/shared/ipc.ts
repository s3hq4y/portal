/**
 * IPC contract between the renderer and the main process.
 * Request/response uses ipcMain.handle / ipcRenderer.invoke;
 * main→renderer pushes use webContents.send.
 */
import type {
  ActivityItem,
  BridgeState,
  BrowserWindowInfo,
  ErrorAdvice,
  LogEntry,
  PromptTemplate,
  SessionStats,
  TunnelDiagnostics,
} from "./types";

export const CH = {
  // renderer → main (invoke)
  GetState: "portal:getState",
  Start: "portal:start",
  Stop: "portal:stop",
  GetConfig: "portal:getConfig",
  SetConfig: "portal:setConfig",
  GetDiag: "portal:getDiag",
  RefreshDiag: "portal:refreshDiag",
  GetLogs: "portal:getLogs",
  ClearLogs: "portal:clearLogs",
  GetTools: "portal:getTools",
  GetActivities: "portal:getActivities",
  GetStats: "portal:getStats",
  GetPrompts: "portal:getPrompts",
  AddPrompt: "portal:addPrompt",
  UpdatePrompt: "portal:updatePrompt",
  DeletePrompt: "portal:deletePrompt",
  CopyText: "portal:copyText",
  CopyUrl: "portal:copyUrl",
  OpenExternal: "portal:openExternal",
  OpenLogFolder: "portal:openLogFolder",
  ChooseWorkspace: "portal:chooseWorkspace",
  SaveCloudflareToken: "portal:saveCloudflareToken",
  ClearCloudflareToken: "portal:clearCloudflareToken",
  ResetRouteToken: "portal:resetRouteToken",
  InstallNgrok: "portal:installNgrok",
  InstallCloudflared: "portal:installCloudflared",
  GetAppInfo: "app:getInfo",
  GetStrings: "app:getStrings",

  // browser
  BrowserList: "browser:list",
  BrowserAttach: "browser:attach",
  BrowserDetach: "browser:detach",
  BrowserAttached: "browser:attached",
  BrowserGrab: "browser:grab",
  BrowserGrabPoint: "browser:grabPoint",
  BrowserCancelGrab: "browser:cancelGrab",
  BrowserOpenEmbedded: "browser:openEmbedded",
  BrowserCloseEmbedded: "browser:closeEmbedded",
  BrowserNavigate: "browser:navigate",
  BrowserControl: "browser:control",
  BrowserEmbedBounds: "browser:embedBounds",
  BrowserDockDragStart: "browser:dockDragStart",
  BrowserDockDragMove: "browser:dockDragMove",
  BrowserDockDragEnd: "browser:dockDragEnd",
  BrowserDockUndock: "browser:dockUndock",

  // window chrome
  WinMinimize: "win:minimize",
  WinMaximize: "win:maximize",
  WinClose: "win:close",
  WinIsMaximized: "win:isMaximized",

  // main → renderer (send)
  EvState: "portal:state",
  EvConfig: "portal:config",
  EvDiag: "portal:diag",
  EvLog: "portal:log",
  EvLogs: "portal:logs",
  EvActivity: "portal:activity",
  EvStats: "portal:stats",
  EvTools: "portal:tools",
  EvPrompts: "portal:prompts",
  EvToast: "portal:toast",
  EvTerminalLine: "agent:line",
  EvBrowserWindows: "browser:windows",
  EvBrowserAttached: "browser:attachedChanged",
  EvBrowserGrab: "browser:grabState",
  EvBrowserEmbedState: "browser:embedState",
  DockTitle: "dock:title",
} as const;

/** Payload of a log event. */
export interface LogPayload {
  entry?: LogEntry;
  logs?: LogEntry[];
  cleared?: boolean;
}

/** A toast/notification surfaced in the renderer. */
export interface Toast {
  kind: "info" | "success" | "warn" | "error";
  message: string;
}

export interface TerminalLine {
  kind: "info" | "out" | "err" | "ok" | "fail";
  text: string;
}

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  isWindows: boolean;
  isWin11: boolean;
  language: "en" | "zh";
  userData: string;
}

export interface ConfigSnapshot {
  tunnelProvider: string;
  ngrokDomain: string;
  ngrokPoolingEnabled: boolean;
  cloudflareDomain: string;
  customTunnelCommand: string;
  customTunnelShell: string;
  customTunnelUrl: string;
  customTunnelUrlPattern: string;
  customTunnelReadyPattern: string;
  customTunnelTimeoutMs: number;
  routeToken: string;
  localPort: number;
  startOnActivation: boolean;
  showCommandsInTerminal: boolean;
  maxTransferBytes: number;
  promptTemplates: PromptTemplate[];
  agentInstructions: string;
  workspaceRoot: string;
  cloudflareTunnelTokenSet: boolean;
  language: string;
}

export interface PromptsPayload {
  templates: PromptTemplate[];
  url?: string;
}

export interface PortalApi {
  // portal
  getState(): Promise<BridgeState>;
  start(): Promise<BridgeState>;
  stop(): Promise<BridgeState>;
  getConfig(): Promise<ConfigSnapshot>;
  setConfig(key: string, value: unknown): Promise<ConfigSnapshot>;
  getDiag(): Promise<TunnelDiagnostics | null>;
  refreshDiag(): Promise<TunnelDiagnostics>;
  getLogs(): Promise<LogEntry[]>;
  clearLogs(): Promise<void>;
  getTools(): Promise<Array<{ name: string; description: string }>>;
  getActivities(): Promise<ActivityItem[]>;
  getStats(): Promise<SessionStats>;
  getPrompts(): Promise<PromptsPayload>;
  addPrompt(p: PromptTemplate): Promise<PromptsPayload>;
  updatePrompt(index: number, p: PromptTemplate): Promise<PromptsPayload>;
  deletePrompt(index: number): Promise<PromptsPayload>;
  copyText(text: string): Promise<void>;
  copyUrl(): Promise<void>;
  openExternal(url: string): Promise<void>;
  openLogFolder(): Promise<void>;
  chooseWorkspace(): Promise<ConfigSnapshot>;
  saveCloudflareToken(token: string): Promise<ConfigSnapshot>;
  clearCloudflareToken(): Promise<ConfigSnapshot>;
  resetRouteToken(): Promise<ConfigSnapshot>;
  installNgrok(): Promise<void>;
  installCloudflared(): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  getStrings(): Promise<{ lang: "en" | "zh"; strings: Record<string, string> }>;

  // browser
  browserList(): Promise<BrowserWindowInfo[]>;
  browserAttach(hwnd: number): Promise<void>;
  browserDetach(hwnd: number): Promise<void>;
  browserAttached(): Promise<BrowserWindowInfo[]>;
  browserGrab(): Promise<void>;
  browserGrabPoint(x: number, y: number): Promise<void>;
  browserCancelGrab(): Promise<void>;
  browserOpenEmbedded(url: string): Promise<void>;
  browserCloseEmbedded(): Promise<void>;
  browserNavigate(url: string): Promise<void>;
  browserControl(action: "back" | "forward" | "reload" | "stop"): Promise<void>;
  browserEmbedBounds(rect: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  browserDockDragStart(x: number, y: number): Promise<void>;
  browserDockDragMove(x: number, y: number): Promise<void>;
  browserDockDragEnd(): Promise<void>;
  browserDockUndock(): Promise<void>;

  // window chrome
  winMinimize(): Promise<void>;
  winMaximize(): Promise<void>;
  winClose(): Promise<void>;
  winIsMaximized(): Promise<boolean>;

  // events
  on(channel: string, cb: (payload: any) => void): () => void;
}

/** Config keys settable from the UI. */
export type ConfigKey =
  | "tunnelProvider"
  | "ngrokDomain"
  | "ngrokPoolingEnabled"
  | "cloudflareDomain"
  | "customTunnelCommand"
  | "customTunnelShell"
  | "customTunnelUrl"
  | "customTunnelUrlPattern"
  | "customTunnelReadyPattern"
  | "customTunnelTimeoutMs"
  | "routeToken"
  | "localPort"
  | "startOnActivation"
  | "showCommandsInTerminal"
  | "maxTransferBytes"
  | "agentInstructions"
  | "workspaceRoot"
  | "language";

export type { ErrorAdvice };
