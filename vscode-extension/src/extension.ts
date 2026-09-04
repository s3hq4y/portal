/**
 * Extension entry point.
 *
 * Responsibilities:
 *  - instantiate the SessionHub (which owns a BridgeManager per MCP session,
 *    so several independent MCP endpoints can run in parallel)
 *  - register every `portal.*` command (start/stop, provider setup, sessions)
 *  - mount the UI surfaces: sidebar panel, settings page, status bar item
 *  - auto-start the active session when a workspace is opened (if configured)
 */
import * as vscode from "vscode";
import { SessionHub } from "./session-hub";
import { SidebarPanel } from "./sidebar/panel";
import { SettingsPage } from "./settings-page";
import { installStatusBar } from "./status-bar";
import { readConfig, readTokenProfiles, updateConfig, watchConfig } from "./config";
import { generateRouteToken } from "./mcp-server";
import { detectCloudflared, detectNgrok, installCloudflaredViaWinget, installNgrokViaWinget } from "./tunnel";
import { getActiveProfileName, listProfiles, setActiveProfile, summarizeProfile } from "./profiles";
import { promptNeedsUrl, promptPreview, renderPrompt } from "./prompts";
import { t } from "./nls";

let hub: SessionHub | undefined;
let panel: SidebarPanel | undefined;
let settings: SettingsPage | undefined;

// Called by VS Code on activation. Wires up logging, the manager and all commands.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Output channel doubles as the extension log; every BridgeManager log line is mirrored here.
  const output = vscode.window.createOutputChannel(t("log.outputChannel"));
  output.appendLine(`[${new Date().toISOString()}] INFO  ${t("log.activating", context.extension.packageJSON?.version ?? "?")}`);
  hub = new SessionHub(output, context.secrets);
  panel = new SidebarPanel(hub);
  settings = new SettingsPage(hub, context.secrets);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("portal.panel", panel!),
  );
  context.subscriptions.push(installStatusBar(hub));
  context.subscriptions.push(
    // Everything below is pushed onto context.subscriptions so VS Code disposes it automatically.
    vscode.commands.registerCommand("portal.start", () => hub!.start()),
    vscode.commands.registerCommand("portal.stop",  () => hub!.stop()),
    vscode.commands.registerCommand("portal.restart", () => hub!.restart()),
    // ---- MCP session management ----
    vscode.commands.registerCommand("portal.tokenSelect", async () => {
      const profiles = readTokenProfiles();
      const items = profiles.length
        ? profiles.map((p) => ({ label: p.label, description: p.routeToken, id: p.id }))
        : [{ label: t("session.defaultLabel"), description: readConfig().routeToken, id: "default" }];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: t("msg.pickToken") });
      if (pick) hub!.setActive((pick as { id: string }).id);
    }),
    vscode.commands.registerCommand("portal.tokenAdd", async () => {
      const label = await vscode.window.showInputBox({ title: t("msg.tokenLabelTitle"), placeHolder: t("msg.tokenLabelPlaceholder") });
      if (label === undefined) return;
      const token = generateRouteToken();
      const profiles = readTokenProfiles();
      const base = label.trim() || `session-${profiles.length + 1}`;
      let id = base;
      let n = 2;
      while (profiles.some((p) => p.id === id)) id = `${base}-${n++}`;
      await updateConfig("tokens", [...profiles, { id, label: base, routeToken: token }]);
      vscode.window.showInformationMessage(t("msg.tokenAdded", base));
    }),
    vscode.commands.registerCommand("portal.tokenRemove", async () => {
      const profiles = readTokenProfiles();
      if (!profiles.length) return;
      const pick = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p.label, description: p.routeToken, id: p.id })),
        { placeHolder: t("msg.pickTokenRemove") },
      );
      if (!pick) return;
      await updateConfig("tokens", profiles.filter((p) => p.id !== (pick as { id: string }).id));
    }),
    vscode.commands.registerCommand("portal.switchProfile", () => switchProfile(hub!)),
    vscode.commands.registerCommand("portal.showPanel", () => settings!.show()),
    vscode.commands.registerCommand("portal.showLog", () => output.show()),
    vscode.commands.registerCommand("portal.showAgentTerminal", () => hub!.showAgentTerminal()),
    vscode.commands.registerCommand("portal.checkTunnel", () => hub!.refreshDiagnostics()),
    vscode.commands.registerCommand("portal.copyUrl", async () => { await settings!.copyUrl(); }),
    // Copy a pre-authored prompt template with {url} substituted by the
    // current (or deterministic predicted) public MCP URL.
    vscode.commands.registerCommand("portal.copyPrompt", async () => {
      const snap = hub!.getPromptSnapshot();
      if (!snap.templates.length) {
        vscode.window.showInformationMessage(t("msg.noPrompts", "portal.copyPrompt"));
        return;
      }
      const pick = await vscode.window.showQuickPick(
        snap.templates.map((tp, i) => ({
          label: tp.name,
          detail: promptPreview(renderPrompt(tp.text, snap.url)),
          idx: i,
        })),
        { placeHolder: t("msg.pickPrompt") },
      );
      if (!pick) return;
      const tpl = snap.templates[pick.idx];
      const text = renderPrompt(tpl.text, snap.url);
      if (promptNeedsUrl(text)) {
        vscode.window.showInformationMessage(t("msg.startFirst"));
        return;
      }
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(t("msg.promptCopied", tpl.name));
    }),
    vscode.commands.registerCommand("portal.installCloudflared", async () => {
      try { await installCloudflaredViaWinget(); vscode.window.showInformationMessage(t("msg.cfInstalled")); }
      catch (e: any) { vscode.window.showErrorMessage(t("msg.installFailed", e?.message ?? e)); }
      await hub!.refreshDiagnostics();
    }),
    vscode.commands.registerCommand("portal.installNgrok", async () => {
      try { await installNgrokViaWinget(); vscode.window.showInformationMessage(t("msg.ngrokInstalled")); }
      catch (e: any) { vscode.window.showErrorMessage(t("msg.installFailed", e?.message ?? e)); }
      await hub!.refreshDiagnostics();
    }),
    // QuickPick flows for the three most common settings (provider / domain / token).
    vscode.commands.registerCommand("portal.setTunnelProvider", async () => {
      const state = hub!.getState();
      if (state.kind === "starting" || state.kind === "running") {
        vscode.window.showWarningMessage(t("msg.providerLocked"));
        return;
      }
      const pick = await vscode.window.showQuickPick([
        { label: t("provider.ngrok-reserved.name"),   description: t("provider.ngrok-reserved.pickDesc"),   id: "ngrok-reserved" },
        { label: t("provider.cloudflare-quick.name"), description: t("provider.cloudflare-quick.pickDesc"), id: "cloudflare-quick" },
        { label: t("provider.cloudflare-named.name"), description: t("provider.cloudflare-named.pickDesc"), id: "cloudflare-named" },
        { label: t("provider.custom.name"),           description: t("provider.custom.pickDesc"),           id: "custom" },
      ] as any[], { placeHolder: t("msg.pickProvider") });
      if (pick) await updateConfig("tunnelProvider", (pick as any).id);
    }),
    vscode.commands.registerCommand("portal.setNgrokDomain", async () => {
      const cur = readConfig().ngrokDomain;
      const v = await vscode.window.showInputBox({ title: t("msg.ngrokDomainTitle"), value: cur, placeHolder: "your-name.ngrok-free.dev" });
      if (v !== undefined) await updateConfig("ngrokDomain", v.trim());
    }),
    vscode.commands.registerCommand("portal.setRouteToken", async () => {
      const cur = readConfig().routeToken;
      const v = await vscode.window.showInputBox({ title: t("msg.routeTokenTitle"), value: cur, password: true });
      if (v !== undefined) await updateConfig("routeToken", v.trim());
    }),
  );
  // React to runtime setting changes: refresh the settings page and re-probe tunnel binaries.
  context.subscriptions.push(watchConfig(() => { settings?.refresh(); hub?.refreshDiagnostics().catch(() => {}); }));
  hub.refreshDiagnostics().catch(() => {});
  const cfg = readConfig();
  // Auto-start 200 ms after activation so the workspace has settled first.
  if (cfg.startOnActivation && vscode.workspace.workspaceFolders?.length) {
    setTimeout(() => { hub!.start().catch((e) => output.appendLine(`[auto-start err] ${e?.message ?? e}`)); }, 200);
  }
  // Final teardown on deactivation.
  context.subscriptions.push({ dispose: () => { hub?.dispose(); hub = undefined; panel = undefined; settings = undefined; } });
}
export function deactivate(): void { hub?.dispose(); }

// Quick pick over the stored connection profiles. The selection is written to
// the workspace when a folder is open, so each window keeps its own choice.
async function switchProfile(hub: SessionHub): Promise<void> {
  const profiles = listProfiles();
  if (!profiles.length) {
    vscode.window.showInformationMessage(t("profile.noneDefined"));
    return;
  }
  const active = getActiveProfileName();
  const items: Array<vscode.QuickPickItem & { name: string }> = [
    { label: t("profile.defaultOption"), description: "", name: "" },
    ...profiles.map((p) => ({ label: p.name, description: summarizeProfile(p), name: p.name })),
  ];
  for (const item of items) {
    if (item.name === active) {
      item.description = (item.description ? `${item.description} \u00b7 ` : "") + t("profile.activeTag");
    }
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: t("profile.pickPlaceholder") });
  if (!pick || pick.name === active) return;
  const label = pick.name || t("profile.defaultOption");
  const target = await setActiveProfile(pick.name);
  if (target === vscode.ConfigurationTarget.Global) vscode.window.showWarningMessage(t("profile.noFolder"));
  const st = hub.getState();
  if (st.kind === "running" || st.kind === "starting") {
    const answer = await vscode.window.showInformationMessage(t("profile.switchedRestart", label), t("profile.restartNow"));
    if (answer) await hub.restart();
  } else {
    vscode.window.showInformationMessage(t("profile.switched", label));
  }
}
