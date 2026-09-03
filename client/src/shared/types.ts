/**
 * Shared domain types for the whole app (state machine, diagnostics, UI models).
 * This is the vscode-free equivalent of the Portal extension's src/types.ts.
 */

export type TunnelProvider = "ngrok-reserved" | "cloudflare-quick" | "cloudflare-named" | "custom";

export interface ErrorAdvice {
  code?: string;
  title: string;
  solution: string;
  link?: string;
}

export interface PromptTemplate {
  name: string;
  text: string;
}

export type CustomTunnelShell = "default" | "powershell" | "pwsh" | "cmd" | "bash";

export type BridgeState =
  | { kind: "idle" }
  | { kind: "starting"; since: number; provider: TunnelProvider }
  | {
      kind: "running";
      since: number;
      provider: TunnelProvider;
      publicUrl: string;
      localPort: number;
      routeToken?: string;
      tunnelPid?: number;
      workspaceRoot?: string;
    }
  | { kind: "error"; since: number; provider?: TunnelProvider; message: string; advice?: ErrorAdvice };

export interface TunnelDiagnostics {
  provider: TunnelProvider;
  cloudflaredInstalled: boolean;
  cloudflaredVersion?: string;
  cloudflareTunnelTokenSet: boolean;
  cloudflareDomain?: string;
  cloudflareNamedReady: boolean;
  ngrokInstalled: boolean;
  ngrokVersion?: string;
  ngrokConfigValid: boolean;
  ngrokDomain?: string;
  lastError?: string;
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

export interface ActivityItem {
  id: string;
  ts: number;
  tool: string;
  title: string;
  detail: string;
  durationMs: number;
  ok: boolean;
}

export interface SessionStats {
  connected: boolean;
  toolCalls: number;
  failures: number;
  totalResponseMs: number;
  lastTool?: string;
  lastToolAt?: number;
  activeRequests: number;
  protocol: string;
}

/** One row of the browser-window capture list (Win32 enumeration). */
export interface BrowserWindowInfo {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
  attached: boolean;
  /** True when this window is currently parented into the Portal dock. */
  embedded: boolean;
}

export type EmbedState = "idle" | "grabbing";
