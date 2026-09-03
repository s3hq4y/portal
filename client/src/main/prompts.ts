/**
 * Prompt templates — pre-authored prompts that embed the live public URL.
 */
import type { PortalConfig } from "./settings-store";
import type { PromptTemplate } from "../shared/types";

// Placeholder that receives the public MCP URL.
export const PROMPT_URL_TOKEN = /\{url\}/gi;

export function promptNeedsUrl(text: string): boolean {
  PROMPT_URL_TOKEN.lastIndex = 0;
  return PROMPT_URL_TOKEN.test(text);
}

/** Replace {url} with a concrete URL; when unknown, keep the token literal. */
export function renderPrompt(text: string, url?: string): string {
  return url ? text.replace(PROMPT_URL_TOKEN, url) : text;
}

/** One-line preview for pickers / lists. */
export function promptPreview(text: string, max = 90): string {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "\u2026" : one;
}

/**
 * Deterministic public URL when Portal is not running. Only possible for
 * providers with a fixed public hostname.
 */
export function predictPublicUrl(cfg: PortalConfig): string | undefined {
  const token = (cfg.routeToken || "").trim();
  if (!token) return undefined;
  const path = `/mcp/${encodeURIComponent(token)}`;
  switch (cfg.tunnelProvider) {
    case "ngrok-reserved":
      return cfg.ngrokDomain ? `https://${cfg.ngrokDomain.replace(/^https?:\/\//i, "")}${path}` : undefined;
    case "cloudflare-named":
      return cfg.cloudflareDomain ? `https://${cfg.cloudflareDomain.replace(/^https?:\/\//i, "")}${path}` : undefined;
    case "custom":
      return cfg.customTunnelUrl ? `${cfg.customTunnelUrl.replace(/\/+$/, "")}${path}` : undefined;
    default:
      return undefined;
  }
}

/** The URL a prompt should embed right now: running URL wins, else prediction. */
export function currentPublicUrl(
  cfg: PortalConfig,
  state: { kind: string; publicUrl?: string },
): string | undefined {
  if (state.kind === "running" && state.publicUrl) return state.publicUrl;
  return predictPublicUrl(cfg);
}

/** Read + sanitize templates from config (storage stays type-safe). */
export function readPromptTemplates(cfg: PortalConfig): PromptTemplate[] {
  return cfg.promptTemplates;
}
