/**
 * Named connection profiles.
 *
 * Storage split (this is the whole point of the feature):
 *  - the profile LIST lives in **Global** settings — it is machine-wide
 *    knowledge (which ngrok accounts/domains exist);
 *  - the SELECTION (`portal.activeProfile`) is written to the **Workspace**
 *    whenever a folder is open, so two VS Code windows can run different
 *    profiles at the same time instead of overwriting each other.
 */
import * as vscode from "vscode";
import { ConnectionProfile, CustomTunnelShell, TunnelProvider } from "./types";

const SECTION = "portal";
const NAME_MAX = 60;

const PROVIDERS: readonly string[] = ["ngrok-reserved", "cloudflare-quick", "cloudflare-named", "custom"];
const SHELLS: readonly string[] = ["default", "powershell", "pwsh", "cmd", "bash"];

/** Paths pasted from Windows usually keep their surrounding quotes. */
function stripQuotes(s: string): string {
  const v = s.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Drop junk from hand-edited settings.json; returns [] for anything unexpected. */
export function sanitizeProfiles(value: unknown): ConnectionProfile[] {
  if (!Array.isArray(value)) return [];
  const out: ConnectionProfile[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const p = sanitizeProfile(raw);
    if (!p || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p);
  }
  return out;
}

/** Validate one raw profile object; undefined when it has no usable name. */
export function sanitizeProfile(raw: unknown): ConnectionProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? "").trim().slice(0, NAME_MAX);
  if (!name) return undefined;
  const p: ConnectionProfile = { name };
  if (typeof o.tunnelProvider === "string" && PROVIDERS.includes(o.tunnelProvider)) {
    p.tunnelProvider = o.tunnelProvider as TunnelProvider;
  }
  if (typeof o.ngrokDomain === "string") p.ngrokDomain = o.ngrokDomain.trim();
  if (typeof o.ngrokPoolingEnabled === "boolean") p.ngrokPoolingEnabled = o.ngrokPoolingEnabled;
  if (typeof o.ngrokConfigPath === "string") p.ngrokConfigPath = stripQuotes(o.ngrokConfigPath.trim());
  if (typeof o.ngrokApiPort === "number" && Number.isFinite(o.ngrokApiPort)) p.ngrokApiPort = clamp(o.ngrokApiPort, 1, 65535);
  if (typeof o.cloudflareDomain === "string") p.cloudflareDomain = o.cloudflareDomain.trim();
  if (typeof o.customTunnelCommand === "string") p.customTunnelCommand = o.customTunnelCommand;
  if (typeof o.customTunnelShell === "string" && SHELLS.includes(o.customTunnelShell)) {
    p.customTunnelShell = o.customTunnelShell as CustomTunnelShell;
  }
  if (typeof o.customTunnelUrl === "string") p.customTunnelUrl = o.customTunnelUrl.trim();
  if (typeof o.customTunnelUrlPattern === "string") p.customTunnelUrlPattern = o.customTunnelUrlPattern;
  if (typeof o.customTunnelReadyPattern === "string") p.customTunnelReadyPattern = o.customTunnelReadyPattern;
  if (typeof o.customTunnelTimeoutMs === "number" && Number.isFinite(o.customTunnelTimeoutMs)) {
    p.customTunnelTimeoutMs = clamp(o.customTunnelTimeoutMs, 5_000, 600_000);
  }
  if (typeof o.routeToken === "string") p.routeToken = o.routeToken;
  if (typeof o.localPort === "number" && Number.isFinite(o.localPort)) p.localPort = clamp(o.localPort, 0, 65535);
  if (typeof o.maxTransferBytes === "number" && Number.isFinite(o.maxTransferBytes)) {
    p.maxTransferBytes = clamp(o.maxTransferBytes, 1024 * 1024, 2 * 1024 * 1024 * 1024);
  }
  return p;
}

export function listProfiles(): ConnectionProfile[] {
  return sanitizeProfiles(vscode.workspace.getConfiguration(SECTION).get<unknown>("connectionProfiles", []));
}

export function getActiveProfileName(): string {
  return (vscode.workspace.getConfiguration(SECTION).get<string>("activeProfile") ?? "").trim();
}

/**
 * Where the selection is stored: the workspace when a folder is open (so each
 * window keeps its own choice), otherwise global (nothing else is possible).
 */
export function selectionTarget(): vscode.ConfigurationTarget {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

export async function setActiveProfile(name: string): Promise<vscode.ConfigurationTarget> {
  const target = selectionTarget();
  await vscode.workspace.getConfiguration(SECTION).update("activeProfile", name, target);
  return target;
}

export async function saveProfiles(list: readonly ConnectionProfile[]): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(
    "connectionProfiles",
    list.map((p) => sanitizeProfile(p) ?? p),
    vscode.ConfigurationTarget.Global,
  );
}

export async function upsertProfile(profile: ConnectionProfile): Promise<void> {
  const list = listProfiles();
  const i = list.findIndex((p) => p.name === profile.name);
  if (i >= 0) list[i] = profile;
  else list.push(profile);
  await saveProfiles(list);
}

export async function deleteProfile(name: string): Promise<void> {
  await saveProfiles(listProfiles().filter((p) => p.name !== name));
  if (getActiveProfileName() === name) await setActiveProfile("");
}

export async function duplicateProfile(name: string): Promise<string | undefined> {
  const list = listProfiles();
  const src = list.find((p) => p.name === name);
  if (!src) return undefined;
  let candidate = `${src.name} copy`;
  let n = 2;
  while (list.some((p) => p.name === candidate)) candidate = `${src.name} copy ${n++}`;
  await saveProfiles([...list, { ...src, name: candidate }]);
  return candidate;
}

/** Write a single field onto a profile (used when the user edits a connection field while a profile is active). */
export async function patchProfile(name: string, patch: Partial<ConnectionProfile>): Promise<void> {
  const list = listProfiles();
  const i = list.findIndex((p) => p.name === name);
  if (i < 0) return;
  const merged = sanitizeProfile({ ...list[i], ...patch, name: list[i].name });
  list[i] = merged ?? list[i];
  await saveProfiles(list);
}

/** One-line summary used in pickers and lists. */
export function summarizeProfile(p: ConnectionProfile): string {
  const parts: string[] = [];
  if (p.tunnelProvider) parts.push(p.tunnelProvider);
  if (p.ngrokDomain) parts.push(p.ngrokDomain);
  if (p.cloudflareDomain) parts.push(p.cloudflareDomain);
  if (p.customTunnelUrl) parts.push(p.customTunnelUrl);
  if (p.ngrokConfigPath) parts.push(`--config ${p.ngrokConfigPath}`);
  if (p.ngrokApiPort) parts.push(`:${p.ngrokApiPort}`);
  if (p.routeToken) parts.push("token set");
  return parts.join(" · ");
}
