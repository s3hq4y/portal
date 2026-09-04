/**
 * Typed accessor for all `portal.*` settings
 * (see package.json contributes.configuration).
 * readConfig() returns a fully-defaulted snapshot; updateConfig() writes one key.
 */
import * as vscode from "vscode";
import { ConnectionProfile, CustomTunnelShell, MCPTokenProfile, PromptTemplate, TunnelProvider } from "./types";
import { sanitizeProfiles } from "./profiles";

// Configuration section prefix in settings.json.
const SECTION = "portal";

// Valid ids shared by the profile/session sanitizers.
const PROVIDER_IDS: readonly string[] = ["ngrok-reserved", "cloudflare-quick", "cloudflare-named", "custom"];
const SHELL_IDS: readonly string[] = ["default", "powershell", "pwsh", "cmd", "bash"];

// Cloudflare Tunnel tokens are credentials, so they live in VS Code SecretStorage
// rather than settings.json. Both BridgeManager and SettingsPage use this key.
export const CLOUDFLARE_TUNNEL_TOKEN_SECRET = "portal.cloudflareTunnelToken";

export interface PortalConfig {
  tunnelProvider: TunnelProvider;
  ngrokDomain: string;
  ngrokPoolingEnabled: boolean;
  ngrokConfigPath: string;
  ngrokApiPort: number;
  cloudflareDomain: string;
  customTunnelCommand: string;
  customTunnelShell: CustomTunnelShell;
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
  // Profile support: the whole list plus the resolved name of the selected one
  // ("" when no profile is active).
  connectionProfiles: ConnectionProfile[];
  activeProfile: string;
  // Multi-session support: independent MCP sessions (each = tunnel + route
  // token + optional workspace/tunnel overrides) that can run in parallel.
  tokens: MCPTokenProfile[];
  activeTokenId: string;
}

// Snapshot of the current config with defaults applied and values sanitized.
// Local inspection port Portal polls when the user has not pinned one (see tunnel.ts).
const NGROK_API_PORT_DEFAULT = 4040;

export function readConfig(): PortalConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const profiles = sanitizeProfiles(c.get<unknown>("connectionProfiles", []));
  const requested = (c.get<string>("activeProfile") ?? "").trim();
  const base: PortalConfig = {
    tunnelProvider: c.get<TunnelProvider>("tunnelProvider", "cloudflare-quick"),
    ngrokDomain: (c.get<string>("ngrokDomain") ?? "").trim(),
    ngrokPoolingEnabled: c.get<boolean>("ngrokPoolingEnabled", false),
    ngrokConfigPath: stripQuotes((c.get<string>("ngrokConfigPath") ?? "").trim()),
    ngrokApiPort: optionalPort(c.get<number>("ngrokApiPort", 0)),
    cloudflareDomain: (c.get<string>("cloudflareDomain") ?? "").trim(),
    customTunnelCommand: c.get<string>("customTunnelCommand", ""),
    customTunnelShell: sanitizeCustomShell(c.get<CustomTunnelShell>("customTunnelShell", "default")),
    customTunnelUrl: (c.get<string>("customTunnelUrl") ?? "").trim().replace(/\/+$/, ""),
    customTunnelUrlPattern: c.get<string>("customTunnelUrlPattern", ""),
    customTunnelReadyPattern: c.get<string>("customTunnelReadyPattern", ""),
    customTunnelTimeoutMs: Math.max(5_000, c.get<number>("customTunnelTimeoutMs", 30_000)),
    routeToken: c.get<string>("routeToken", ""),
    localPort: Math.max(0, c.get<number>("localPort", 0)),
    startOnActivation: c.get<boolean>("startOnActivation", true),
    showCommandsInTerminal: c.get<boolean>("showCommandsInTerminal", true),
    maxTransferBytes: Math.max(1024 * 1024, c.get<number>("maxTransferBytes", 64 * 1024 * 1024)),
    promptTemplates: sanitizeTemplates(c.get<unknown>("promptTemplates", [])),
    agentInstructions: (c.get<string>("agentInstructions", "") ?? "").trim(),
    connectionProfiles: profiles,
    activeProfile: "",
    tokens: sanitizeTokens(c.get<unknown>("tokens", [])),
    activeTokenId: (c.get<string>("activeTokenId") ?? "").trim(),
  };
  return applyActiveProfile(base, profiles, requested);
}

// Overlay the selected profile's defined fields on top of the plain settings:
// while a profile is active it is the single source of truth for the connection.
function applyActiveProfile(base: PortalConfig, profiles: readonly ConnectionProfile[], requested: string): PortalConfig {
  const active = requested ? profiles.find((p) => p.name === requested) : undefined;
  if (!active) return base;
  const out: PortalConfig = { ...base, activeProfile: active.name };
  if (active.tunnelProvider) out.tunnelProvider = active.tunnelProvider;
  if (typeof active.ngrokDomain === "string") out.ngrokDomain = active.ngrokDomain.trim();
  if (typeof active.ngrokPoolingEnabled === "boolean") out.ngrokPoolingEnabled = active.ngrokPoolingEnabled;
  if (typeof active.ngrokConfigPath === "string") out.ngrokConfigPath = stripQuotes(active.ngrokConfigPath.trim());
  if (typeof active.ngrokApiPort === "number") out.ngrokApiPort = optionalPort(active.ngrokApiPort);
  if (typeof active.cloudflareDomain === "string") out.cloudflareDomain = active.cloudflareDomain.trim();
  if (typeof active.customTunnelCommand === "string") out.customTunnelCommand = active.customTunnelCommand;
  if (typeof active.customTunnelShell === "string") out.customTunnelShell = sanitizeCustomShell(active.customTunnelShell);
  if (typeof active.customTunnelUrl === "string") out.customTunnelUrl = active.customTunnelUrl.trim().replace(/\/+$/, "");
  if (typeof active.customTunnelUrlPattern === "string") out.customTunnelUrlPattern = active.customTunnelUrlPattern;
  if (typeof active.customTunnelReadyPattern === "string") out.customTunnelReadyPattern = active.customTunnelReadyPattern;
  if (typeof active.customTunnelTimeoutMs === "number") out.customTunnelTimeoutMs = Math.max(5_000, active.customTunnelTimeoutMs);
  if (typeof active.routeToken === "string") out.routeToken = active.routeToken;
  if (typeof active.localPort === "number") out.localPort = Math.max(0, active.localPort);
  if (typeof active.maxTransferBytes === "number") out.maxTransferBytes = Math.max(1024 * 1024, active.maxTransferBytes);
  return out;
}

// Paths pasted from Windows ("C:\ngrok\a.yml") usually keep their quotes;
// they are handed to spawn verbatim, so the quotes must be removed.
function stripQuotes(s: string): string {
  const v = s.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

// 0 means "not configured" — ngrok then picks its own inspection port.
function optionalPort(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 65_535) return 0;
  return Math.round(n);
}

// Keep only well-shaped templates: { name, text }; plain strings are accepted
// from hand-edited settings.json and wrapped with a derived name.
const PROMPT_NAME_MAX = 60;
const PROMPT_TEXT_MAX = 4000;
function sanitizeTemplates(value: unknown): PromptTemplate[] {
  if (!Array.isArray(value)) return [];
  const out: PromptTemplate[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      const text = raw.trim();
      if (text) out.push({ name: text.replace(/\s+/g, " ").slice(0, 24), text });
      continue;
    }
    if (raw && typeof raw === "object") {
      const name = String((raw as any).name ?? "").trim().slice(0, PROMPT_NAME_MAX);
      const text = String((raw as any).text ?? "").trim().slice(0, PROMPT_TEXT_MAX);
      if (text) out.push({ name: name || text.replace(/\s+/g, " ").slice(0, 24), text });
    }
  }
  return out;
}

export async function updateConfig<K extends keyof PortalConfig>(key: K, value: PortalConfig[K], target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  await c.update(key as string, value, target);
}

// Fire the listener only when a portal.* key changes.
export function watchConfig(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) listener();
  });
}

// Whitelist for the custom-tunnel shell setting; anything else falls back to "default".
const CUSTOM_SHELLS: readonly CustomTunnelShell[] = ["default", "powershell", "pwsh", "cmd", "bash"];
function sanitizeCustomShell(value: CustomTunnelShell): CustomTunnelShell {
  return CUSTOM_SHELLS.includes(value) ? value : "default";
}

// ---------- MCP sessions (token profiles) ----------

/** The configured MCP sessions (never undefined; may be empty). */
export function readTokenProfiles(): MCPTokenProfile[] {
  return readConfig().tokens;
}

/** A synthetic profile describing the legacy single-session defaults. */
export function defaultProfileOverride(): MCPTokenProfile | undefined {
  const cfg = readConfig();
  return {
    id: "default",
    label: "default",
    routeToken: cfg.routeToken,
    workspacePath: undefined,
  };
}

/**
 * Merge a session's overrides onto the effective config, so one BridgeManager
 * can be driven per session. Absent fields fall back to the (connection-profile
 * aware) global settings.
 */
export function effectiveConfigFor(cfg: PortalConfig, profile?: MCPTokenProfile): PortalConfig {
  if (!profile) return cfg;
  return {
    ...cfg,
    tunnelProvider: profile.tunnelProvider ?? cfg.tunnelProvider,
    ngrokDomain: profile.ngrokDomain ?? cfg.ngrokDomain,
    ngrokPoolingEnabled: profile.ngrokPoolingEnabled ?? cfg.ngrokPoolingEnabled,
    ngrokConfigPath: profile.ngrokConfigPath ?? cfg.ngrokConfigPath,
    ngrokApiPort: profile.ngrokApiPort ?? cfg.ngrokApiPort,
    cloudflareDomain: profile.cloudflareDomain ?? cfg.cloudflareDomain,
    customTunnelCommand: profile.customTunnelCommand ?? cfg.customTunnelCommand,
    customTunnelShell: profile.customTunnelShell ?? cfg.customTunnelShell,
    customTunnelUrl: profile.customTunnelUrl ?? cfg.customTunnelUrl,
    customTunnelUrlPattern: profile.customTunnelUrlPattern ?? cfg.customTunnelUrlPattern,
    customTunnelReadyPattern: profile.customTunnelReadyPattern ?? cfg.customTunnelReadyPattern,
    customTunnelTimeoutMs: profile.customTunnelTimeoutMs ?? cfg.customTunnelTimeoutMs,
    routeToken: profile.routeToken || cfg.routeToken,
    localPort: profile.localPort ?? cfg.localPort,
    maxTransferBytes: profile.maxTransferBytes ?? cfg.maxTransferBytes,
  };
}

/** Keep only well-shaped sessions; plain strings are accepted from hand-edited settings.json. */
export function sanitizeTokens(value: unknown): MCPTokenProfile[] {
  if (!Array.isArray(value)) return [];
  const out: MCPTokenProfile[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      const routeToken = raw.trim();
      if (routeToken) out.push({ id: routeToken, label: routeToken, routeToken });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const routeToken = String(o.routeToken ?? o.token ?? "").trim();
    const id = String(o.id ?? "").trim() || routeToken || `token-${out.length}`;
    if (!routeToken && !String(o.id ?? "").trim()) continue;
    const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v));
    out.push({
      id,
      label: String(o.label ?? id).trim() || id,
      routeToken,
      workspacePath: stripQuotes(String(o.workspacePath ?? o.workspace ?? "").trim()) || undefined,
      tunnelProvider: (PROVIDER_IDS.includes(String(o.tunnelProvider)) ? o.tunnelProvider : undefined) as TunnelProvider | undefined,
      ngrokDomain: String(o.ngrokDomain ?? "").trim() || undefined,
      ngrokPoolingEnabled: typeof o.ngrokPoolingEnabled === "boolean" ? o.ngrokPoolingEnabled : undefined,
      ngrokConfigPath: stripQuotes(String(o.ngrokConfigPath ?? "").trim()) || undefined,
      ngrokApiPort: num(o.ngrokApiPort),
      cloudflareDomain: String(o.cloudflareDomain ?? "").trim() || undefined,
      customTunnelCommand: String(o.customTunnelCommand ?? "").trim() || undefined,
      customTunnelShell: (SHELL_IDS.includes(String(o.customTunnelShell)) ? o.customTunnelShell : undefined) as CustomTunnelShell | undefined,
      customTunnelUrl: String(o.customTunnelUrl ?? "").trim() || undefined,
      customTunnelUrlPattern: String(o.customTunnelUrlPattern ?? "").trim() || undefined,
      customTunnelReadyPattern: String(o.customTunnelReadyPattern ?? "").trim() || undefined,
      customTunnelTimeoutMs: num(o.customTunnelTimeoutMs),
      localPort: num(o.localPort),
      maxTransferBytes: num(o.maxTransferBytes),
    });
  }
  return out;
}

