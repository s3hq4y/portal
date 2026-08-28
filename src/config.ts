/**
 * Typed accessor for all `portal.*` settings
 * (see package.json contributes.configuration).
 * readConfig() returns a fully-defaulted snapshot; updateConfig() writes one key.
 */
import * as vscode from "vscode";
import { CustomTunnelShell, PromptTemplate, TunnelProvider } from "./types";

// Configuration section prefix in settings.json.
const SECTION = "portal";

// Cloudflare Tunnel tokens are credentials, so they live in VS Code SecretStorage
// rather than settings.json. Both BridgeManager and SettingsPage use this key.
export const CLOUDFLARE_TUNNEL_TOKEN_SECRET = "portal.cloudflareTunnelToken";

export interface PortalConfig {
  tunnelProvider: TunnelProvider;
  ngrokDomain: string;
  ngrokPoolingEnabled: boolean;
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
}

// Snapshot of the current config with defaults applied and values sanitized.
export function readConfig(): PortalConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    tunnelProvider: c.get<TunnelProvider>("tunnelProvider", "cloudflare-quick"),
    ngrokDomain: (c.get<string>("ngrokDomain") ?? "").trim(),
    ngrokPoolingEnabled: c.get<boolean>("ngrokPoolingEnabled", false),
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
  };
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
