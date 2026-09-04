/** Shared domain types for the whole extension (state machine, diagnostics, UI models). */
export type TunnelProvider = "ngrok-reserved" | "cloudflare-quick" | "cloudflare-named" | "custom";

// A recognized failure with an actionable, localized fix (see error-doctor.ts).
export interface ErrorAdvice {
  code?: string;
  title: string;
  solution: string;
  link?: string;
}

// A user-authored prompt preset; {url} receives the public MCP URL at copy time.
export interface PromptTemplate {
  name: string;
  text: string;
}

// Shell flavors available to the custom tunnel command runner.
export type CustomTunnelShell = "default" | "powershell" | "pwsh" | "cmd" | "bash";

// A named bundle of connection settings (provider, domain, ngrok account, ...).
// The list is stored globally; the *selection* is stored per workspace so two
// VS Code windows can run different profiles at the same time. Every field is
// optional: an unset field keeps the plain `portal.*` setting.
export interface ConnectionProfile {
  name: string;
  tunnelProvider?: TunnelProvider;
  ngrokDomain?: string;
  ngrokPoolingEnabled?: boolean;
  ngrokConfigPath?: string;
  ngrokApiPort?: number;
  cloudflareDomain?: string;
  customTunnelCommand?: string;
  customTunnelShell?: CustomTunnelShell;
  customTunnelUrl?: string;
  customTunnelUrlPattern?: string;
  customTunnelReadyPattern?: string;
  customTunnelTimeoutMs?: number;
  routeToken?: string;
  localPort?: number;
  maxTransferBytes?: number;
}

// One independent MCP session: its own route token and (optionally) its own
// workspace and tunnel settings. Several sessions can run in parallel, each
// publishing its own public MCP endpoint; the sidebar picks which one is
// "active" for display. Orthogonal to ConnectionProfile: a session decides
// *what* is published, a connection profile decides *how* it is tunnelled.
export interface MCPTokenProfile {
  id: string;                // unique id (also the session key)
  label: string;             // display name in the sidebar
  routeToken: string;        // route token embedded in the public URL; empty => auto-generate
  workspacePath?: string;    // optional folder to expose for this session
  // Optional per-session tunnel overrides (fall back to the effective settings):
  tunnelProvider?: TunnelProvider;
  ngrokDomain?: string;
  ngrokPoolingEnabled?: boolean;
  ngrokConfigPath?: string;
  ngrokApiPort?: number;
  cloudflareDomain?: string;
  customTunnelCommand?: string;
  customTunnelShell?: CustomTunnelShell;
  customTunnelUrl?: string;
  customTunnelUrlPattern?: string;
  customTunnelReadyPattern?: string;
  customTunnelTimeoutMs?: number;
  localPort?: number;
  maxTransferBytes?: number;
}

// State machine: idle -> starting -> running | error. `since` timestamps drive UI timers.
export type BridgeState =
  | { kind: "idle" }
  | { kind: "starting"; since: number; provider: TunnelProvider; profileName?: string }
  | { kind: "running"; since: number; provider: TunnelProvider; publicUrl: string; localPort: number; routeToken?: string; tunnelPid?: number; profileName?: string }
  | { kind: "error"; since: number; provider?: TunnelProvider; message: string; advice?: ErrorAdvice };

// Result of probing the local machine for tunnel binaries + their config validity.
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

export interface LogEntry { ts: number; level: "info" | "warn" | "error" | "debug"; message: string; }

// One entry in the sidebar activity feed.
export interface ActivityItem {
  id: string;
  ts: number;
  tool: string;
  title: string;
  detail: string;
  durationMs: number;
  ok: boolean;
}

// Aggregate numbers shown on the settings page session card.
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
