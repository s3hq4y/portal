/**
 * Extension entry point.
 *
 * Responsibilities:
 *  - instantiate the single BridgeManager (tunnel + MCP server orchestrator)
 *  - register every `portal.*` command (start/stop, provider setup)
 *  - mount the UI surfaces: sidebar panel, settings page, status bar item
 *  - auto-start the bridge when a workspace is opened (if configured)
 */
import * as vscode from "vscode";
import { BridgeManager } from "./bridge-manager";
import { SidebarPanel } from "./sidebar/panel";
import { SettingsPage } from "./settings-page";
import { installStatusBar } from "./status-bar";
import { readConfig, updateConfig, watchConfig } from "./config";
import { detectCloudflared, detectNgrok, installCloudflaredViaWinget, installNgrokViaWinget } from "./tunnel";
import { t } from "./nls";

let bm: BridgeManager | undefined;
let panel: SidebarPanel | undefined;
let settings: SettingsPage | undefined;

// Called by VS Code on activation. Wires up logging, the manager and all commands.
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Output channel doubles as the extension log; every BridgeManager log line is mirrored here.
  const output = vscode.window.createOutputChannel(t("log.outputChannel"));
  output.appendLine(`[${new Date().toISOString()}] INFO  ${t("log.activating", "1.0.0")}`);
  bm = new BridgeManager(output, context.secrets);
  panel = new SidebarPanel(bm);
  settings = new SettingsPage(bm, context.secrets);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("portal.panel", panel!),
  );
  context.subscriptions.push(installStatusBar(bm));
  context.subscriptions.push(
    // Everything below is pushed onto context.subscriptions so VS Code disposes it automatically.
    vscode.commands.registerCommand("portal.start", () => bm!.start()),
    vscode.commands.registerCommand("portal.stop",  () => bm!.stop()),
    vscode.commands.registerCommand("portal.showPanel", () => settings!.show()),
    vscode.commands.registerCommand("portal.showLog", () => output.show()),
    vscode.commands.registerCommand("portal.showAgentTerminal", () => bm!.showAgentTerminal()),
    vscode.commands.registerCommand("portal.checkTunnel", () => bm!.refreshDiagnostics()),
    vscode.commands.registerCommand("portal.copyUrl", async () => { await settings!.copyUrl(); }),
    vscode.commands.registerCommand("portal.installCloudflared", async () => {
      try { await installCloudflaredViaWinget(); vscode.window.showInformationMessage(t("msg.cfInstalled")); }
      catch (e: any) { vscode.window.showErrorMessage(t("msg.installFailed", e?.message ?? e)); }
      await bm!.refreshDiagnostics();
    }),
    vscode.commands.registerCommand("portal.installNgrok", async () => {
      try { await installNgrokViaWinget(); vscode.window.showInformationMessage(t("msg.ngrokInstalled")); }
      catch (e: any) { vscode.window.showErrorMessage(t("msg.installFailed", e?.message ?? e)); }
      await bm!.refreshDiagnostics();
    }),
    // QuickPick flows for the three most common settings (provider / domain / token).
    vscode.commands.registerCommand("portal.setTunnelProvider", async () => {
      const state = bm!.getState();
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
  context.subscriptions.push(watchConfig(() => { settings?.refresh(); bm?.refreshDiagnostics().catch(() => {}); }));
  bm.refreshDiagnostics().catch(() => {});
  const cfg = readConfig();
  // Auto-start 200 ms after activation so the workspace has settled first.
  if (cfg.startOnActivation && vscode.workspace.workspaceFolders?.length) {
    setTimeout(() => { bm!.start().catch((e) => output.appendLine(`[auto-start err] ${e?.message ?? e}`)); }, 200);
  }
  // Final teardown on deactivation.
  context.subscriptions.push({ dispose: () => { bm?.dispose(); bm = undefined; panel = undefined; settings = undefined; } });
}
export function deactivate(): void { bm?.dispose(); }
