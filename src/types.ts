/** Shared domain types for the whole extension (state machine, diagnostics, UI models). */
export type TunnelProvider = "ngrok-reserved" | "cloudflare-quick" | "cloudflare-named" | "custom";

// Shell flavors available to the custom tunnel command runner.
export type CustomTunnelShell = "default" | "powershell" | "pwsh" | "cmd" | "bash";

// State machine: idle -> starting -> running | error. `since` timestamps drive UI timers.
export type BridgeState =
  | { kind: "idle" }
  | { kind: "starting"; since: number; provider: TunnelProvider }
  | { kind: "running"; since: number; provider: TunnelProvider; publicUrl: string; localPort: number; routeToken?: string; tunnelPid?: number }
  | { kind: "error"; since: number; provider?: TunnelProvider; message: string };

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
