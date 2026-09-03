/**
 * Typed settings store persisted as JSON in the app's userData directory
 * (replaces VS Code's workspace configuration + SecretStorage).
 *
 * readConfig() returns a fully-defaulted snapshot; updateConfig() writes one
 * key and persists. Listeners fire on any change.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { CustomTunnelShell, PromptTemplate, TunnelProvider } from "../shared/types";
import type { Language } from "../shared/l10n";

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
  workspaceRoot: string;
  language: Language;
}

export const DEFAULTS: PortalConfig = {
  tunnelProvider: "cloudflare-quick",
  ngrokDomain: "",
  ngrokPoolingEnabled: false,
  cloudflareDomain: "",
  customTunnelCommand: "",
  customTunnelShell: "default",
  customTunnelUrl: "",
  customTunnelUrlPattern: "",
  customTunnelReadyPattern: "",
  customTunnelTimeoutMs: 30_000,
  routeToken: "",
  localPort: 0,
  startOnActivation: true,
  showCommandsInTerminal: true,
  maxTransferBytes: 64 * 1024 * 1024,
  promptTemplates: [],
  agentInstructions: "",
  workspaceRoot: "",
  language: "system",
};

const FILE = () => path.join(app.getPath("userData"), "portal-config.json");

const CUSTOM_SHELLS: readonly CustomTunnelShell[] = ["default", "powershell", "pwsh", "cmd", "bash"];

const PROMPT_NAME_MAX = 60;
const PROMPT_TEXT_MAX = 4000;

class SettingsStore {
  private cache: PortalConfig | undefined;
  private listeners = new Set<() => void>();

  private load(): PortalConfig {
    if (this.cache) return this.cache;
    let raw: Partial<PortalConfig> = {};
    try {
      raw = JSON.parse(fs.readFileSync(FILE(), "utf8")) as Partial<PortalConfig>;
    } catch {
      /* first run / corrupt file */
    }
    this.cache = this.sanitize(raw);
    return this.cache;
  }

  private sanitize(raw: Partial<PortalConfig>): PortalConfig {
    const d = DEFAULTS;
    return {
      tunnelProvider: sanitizeProvider(raw.tunnelProvider),
      ngrokDomain: String(raw.ngrokDomain ?? "").trim(),
      ngrokPoolingEnabled: Boolean(raw.ngrokPoolingEnabled),
      cloudflareDomain: String(raw.cloudflareDomain ?? "").trim(),
      customTunnelCommand: String(raw.customTunnelCommand ?? ""),
      customTunnelShell: sanitizeCustomShell(raw.customTunnelShell),
      customTunnelUrl: String(raw.customTunnelUrl ?? "").trim().replace(/\/+$/, ""),
      customTunnelUrlPattern: String(raw.customTunnelUrlPattern ?? ""),
      customTunnelReadyPattern: String(raw.customTunnelReadyPattern ?? ""),
      customTunnelTimeoutMs: Math.max(5_000, Number(raw.customTunnelTimeoutMs) || d.customTunnelTimeoutMs),
      routeToken: String(raw.routeToken ?? ""),
      localPort: Math.max(0, Number(raw.localPort) || 0),
      startOnActivation: raw.startOnActivation !== false,
      showCommandsInTerminal: raw.showCommandsInTerminal !== false,
      maxTransferBytes: Math.max(1024 * 1024, Number(raw.maxTransferBytes) || d.maxTransferBytes),
      promptTemplates: sanitizeTemplates(raw.promptTemplates),
      agentInstructions: String(raw.agentInstructions ?? "").trim(),
      workspaceRoot: String(raw.workspaceRoot ?? ""),
      language: sanitizeLanguage(raw.language),
    };
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(FILE()), { recursive: true });
      fs.writeFileSync(FILE(), JSON.stringify(this.cache, null, 2), "utf8");
    } catch (e) {
      console.error("Failed to persist config:", e);
    }
  }

  readConfig(): PortalConfig {
    return this.load();
  }

  updateConfig<K extends keyof PortalConfig>(key: K, value: PortalConfig[K]): PortalConfig {
    const current = this.load();
    (current as any)[key] = value;
    this.cache = this.sanitize(current);
    this.persist();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    return this.cache;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolve the effective language for the current app locale + setting. */
  resolveLanguage(): "en" | "zh" {
    const setting = this.readConfig().language;
    if (setting === "en" || setting === "zh") return setting;
    const locale = (app.getLocale() || "en").toLowerCase();
    return locale.startsWith("zh") ? "zh" : "en";
  }
}

function sanitizeProvider(value: unknown): TunnelProvider {
  const v = String(value ?? "");
  if (["ngrok-reserved", "cloudflare-quick", "cloudflare-named", "custom"].includes(v)) return v as TunnelProvider;
  return "cloudflare-quick";
}

function sanitizeCustomShell(value: unknown): CustomTunnelShell {
  const v = String(value ?? "") as CustomTunnelShell;
  return CUSTOM_SHELLS.includes(v) ? v : "default";
}

function sanitizeLanguage(value: unknown): Language {
  const v = String(value ?? "");
  if (v === "en" || v === "zh" || v === "system") return v as Language;
  return "system";
}

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

export const settingsStore = new SettingsStore();

/** Prompt template CRUD persisted through the same store. */
export function writePromptTemplates(templates: PromptTemplate[]): PortalConfig {
  return settingsStore.updateConfig("promptTemplates", templates);
}
