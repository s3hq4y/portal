/**
 * Settings webview panel: bridge control, public URL, provider setup,
 * diagnostics, tool list and a live log tail. The host side only handles
 * messages; rendering lives in renderHtml() below.
 * Win10-flavored flat UI: square corners, Segoe UI, Win10 Settings-style
 * section layout and selection accent bars.
 */
import * as vscode from "vscode";
import { BridgeManager } from "./bridge-manager";
import { generateRouteToken } from "./mcp-server";
import { CLOUDFLARE_TUNNEL_TOKEN_SECRET, readConfig, updateConfig } from "./config";
import { writePromptTemplates } from "./prompts";
import { PromptTemplate, TunnelProvider } from "./types";
import { localeTag, t, webviewL10nScript } from "./nls";

export class SettingsPage {
  public readonly viewId = "portal.settings";
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly bm: BridgeManager, private readonly secrets: vscode.SecretStorage) {}

  // Reveal the existing panel or create it; retainContextWhenHidden keeps the
  // webview alive when hidden.
  show(): void {
    if (this.panel) { this.panel.reveal(); this.pushAll(); return; }
    this.ready = false;
    this.panel = vscode.window.createWebviewPanel(
      this.viewId,
      t("settings.title"),
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    this.panel.webview.html = renderHtml();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.disposables.push(
      this.bm.onState(() => this.push("state", { state: this.bm.getState() })),
      this.bm.onDiagnostics(() => this.push("diag", { diag: this.bm.getDiagnostics() })),
      this.bm.onLog(() => this.push("logs", { logs: this.bm.getLogs().slice(-50) })),
      this.panel.webview.onDidReceiveMessage((m) => this.handle(m)),
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      for (const d of this.disposables) d.dispose();
      this.disposables.length = 0;
    });
  }

  refresh(): void { void this.pushConfig(); }

  private async pushConfig(): Promise<void> {
    const cloudflareTunnelTokenSet = Boolean((await this.secrets.get(CLOUDFLARE_TUNNEL_TOKEN_SECRET))?.trim());
    const cfg = readConfig();
    this.push("config", { config: { ...cfg, cloudflareTunnelTokenSet } });
    this.pushPrompts(cfg.promptTemplates);
  }

  // Push the template list plus the URL {url} should currently render as.
  private pushPrompts(templates: PromptTemplate[]): void {
    const snap = this.bm.getPromptSnapshot();
    this.push("prompts", { templates: templates ?? snap.templates, url: snap.url });
  }

  private push(type: string, payload: Record<string, unknown>): void {
    if (this.panel && this.ready) this.panel.webview.postMessage({ type, ...payload });
  }

  private pushAll(): void {
    this.push("state", { state: this.bm.getState() });
    void this.pushConfig();
    this.push("diag", { diag: this.bm.getDiagnostics() });
    this.push("logs", { logs: this.bm.getLogs().slice(-50) });
    this.push("tools", { tools: this.bm.getExposedTools() });
  }

  // Message protocol from the webview: save config keys, copy url,
  // token regeneration, opening links.
  private async handle(msg: any): Promise<void> {
    switch (msg?.type) {
      case "webviewReady": this.ready = true; this.pushAll(); break;
      case "start": await this.bm.start(); break;
      case "stop": await this.bm.stop(); break;
      case "refreshDiag": await this.bm.refreshDiagnostics(); break;
      case "copyUrl": await this.copyUrl(); break;
      case "copyText":
        await vscode.env.clipboard.writeText(String(msg.text ?? ""));
        vscode.window.showInformationMessage(t("msg.copied"));
        break;
      case "warnStartFirst":
        vscode.window.showInformationMessage(t("msg.startFirst"));
        break;
      case "openExternal": await vscode.env.openExternal(vscode.Uri.parse(String(msg.url))); break;
      case "setProvider":
        if (this.bm.getState().kind === "starting" || this.bm.getState().kind === "running") {
          vscode.window.showWarningMessage(t("msg.providerLocked"));
          this.pushConfig();
          break;
        }
        await updateConfig("tunnelProvider", msg.provider as TunnelProvider);
        this.refresh();
        await this.bm.refreshDiagnostics();
        break;
      case "setNgrokDomain": await updateConfig("ngrokDomain", String(msg.domain ?? "").trim()); this.refresh(); break;
      case "setNgrokPoolingEnabled": await updateConfig("ngrokPoolingEnabled", !!msg.value); this.refresh(); break;
      case "setCloudflareDomain": await updateConfig("cloudflareDomain", String(msg.domain ?? "").trim()); this.refresh(); break;
      case "setCustomTunnelCommand": await updateConfig("customTunnelCommand", String(msg.command ?? "").trim()); this.refresh(); break;
      case "setCustomTunnelUrl": await updateConfig("customTunnelUrl", String(msg.url ?? "").trim()); this.refresh(); break;
      case "saveCloudflareTunnelToken": {
        const token = String(msg.token ?? "").trim();
        if (!token) { vscode.window.showWarningMessage(t("msg.cfTokenEmpty")); break; }
        await this.secrets.store(CLOUDFLARE_TUNNEL_TOKEN_SECRET, token);
        vscode.window.showInformationMessage(t("msg.cfTokenSaved"));
        this.refresh();
        await this.bm.refreshDiagnostics();
        break;
      }
      case "clearCloudflareTunnelToken":
        await this.secrets.delete(CLOUDFLARE_TUNNEL_TOKEN_SECRET);
        vscode.window.showInformationMessage(t("msg.cfTokenCleared"));
        this.refresh();
        await this.bm.refreshDiagnostics();
        break;
      case "setRouteToken": await updateConfig("routeToken", String(msg.token ?? "")); this.refresh(); break;
      // Prompt template CRUD; copy is handled client-side via copyText.
      case "addPrompt": {
        const cfg = readConfig();
        const tpl = sanitizePromptInput(msg);
        if (!tpl) break;
        await writePromptTemplates([...cfg.promptTemplates, tpl]);
        vscode.window.showInformationMessage(t("msg.promptSaved"));
        this.refresh();
        break;
      }
      case "updatePrompt": {
        const cfg = readConfig();
        const tpl = sanitizePromptInput(msg);
        if (!tpl) break;
        const idx = Number(msg.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.promptTemplates.length) break;
        const next = cfg.promptTemplates.slice();
        next[idx] = tpl;
        await writePromptTemplates(next);
        vscode.window.showInformationMessage(t("msg.promptSaved"));
        this.refresh();
        break;
      }
      case "deletePrompt": {
        const cfg = readConfig();
        const idx = Number(msg.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.promptTemplates.length) break;
        const next = cfg.promptTemplates.slice();
        const [removed] = next.splice(idx, 1);
        await writePromptTemplates(next);
        vscode.window.showInformationMessage(t("msg.promptDeleted", removed?.name ?? ""));
        this.refresh();
        break;
      }
      case "setLocalPort": await updateConfig("localPort", Math.max(0, Number(msg.port) || 0)); this.refresh(); break;
      case "setStartOnActivation": await updateConfig("startOnActivation", !!msg.value); this.refresh(); break;
      case "setShowCommandsInTerminal": await updateConfig("showCommandsInTerminal", !!msg.value); this.refresh(); break;
      case "setAgentInstructions":
        await updateConfig("agentInstructions", String(msg.value ?? ""));
        vscode.window.showInformationMessage(t("msg.instructionsSaved"));
        this.refresh();
        break;
      case "resetRouteToken": {
        await updateConfig("routeToken", generateRouteToken());
        this.refresh();
        const st = this.bm.getState();
        if (st.kind === "running" || st.kind === "starting") {
          await this.bm.stop();
          await this.bm.start();
        }
        vscode.window.showInformationMessage(t("msg.tokenReset"));
        break;
      }
      case "installNgrok": await vscode.commands.executeCommand("portal.installNgrok"); break;
      case "installCloudflared": await vscode.commands.executeCommand("portal.installCloudflared"); break;
      case "showLog": await vscode.commands.executeCommand("portal.showLog"); break;
      case "openSettingsJson": await vscode.commands.executeCommand("workbench.action.openSettings", "portal."); break;
    }
  }

  async copyUrl(): Promise<void> {
    const s = this.bm.getState();
    if (s.kind === "running") {
      await vscode.env.clipboard.writeText(s.publicUrl);
      vscode.window.showInformationMessage(t("msg.urlCopied"));
    } else {
      vscode.window.showInformationMessage(t("msg.startFirst"));
    }
  }
}

// Validate a prompt add/update message into a clean template (or undefined).
function sanitizePromptInput(msg: any): PromptTemplate | undefined {
  const name = String(msg?.name ?? "").trim().slice(0, 60);
  const text = String(msg?.text ?? "").trim().slice(0, 4000);
  if (!text) return undefined;
  return { name: name || text.replace(/\s+/g, " ").slice(0, 24), text };
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="${localeTag()}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>${t("settings.title")}</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-foreground, #cccccc);
    --muted: var(--vscode-descriptionForeground, #9d9d9d);
    --border: var(--vscode-panel-border, #3c3c3c);
    --card: var(--vscode-editorWidget-background, #252526);
    --input: var(--vscode-input-background, #3c3c3c);
    /* Win10 design tokens */
    --win-accent: #0078D4;
    --win-accent-hover: #0063B1;
    --win-ok: #107C10;
    --win-warn: #FFB900;
    --win-err: #E81123;
    --win-err-dark: #C42B1C;
  }
  * { box-sizing: border-box; border-radius: 0 !important; }
  body { margin: 0; padding: 0 24px 48px; font: 13px/1.5 "Segoe UI", "Microsoft YaHei UI", -apple-system, sans-serif; color: var(--fg); background: var(--bg); max-width: 780px; }

  /* Win10 Settings-style page header */
  h1 { font-size: 24px; font-weight: 300; margin: 24px 0 4px; display: flex; align-items: center; gap: 10px; }
  h1 .led { width: 12px; height: 12px; background: #808080; flex: none; }
  h1 .led.ok { background: var(--win-ok); }
  h1 .led.starting { background: var(--win-warn); }
  h1 .led.error { background: var(--win-err); }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  h2 { font-size: 13px; margin: 24px 0 8px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  h2::after { content: ""; flex: 1; height: 1px; background: var(--border); }

  .card { border: 1px solid var(--border); padding: 12px; margin-bottom: 8px; background: var(--card); }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .row > * { flex: 1; }
  .row > button { flex: none; }
  input[type=text], input[type=password], input[type=number], textarea {
    width: 100%; background: var(--input); color: var(--fg);
    border: 1px solid var(--border); padding: 5px 8px; font: inherit;
  }
  input:focus, textarea:focus { outline: none; border-color: var(--win-accent); }
  textarea { min-height: 64px; font-family: var(--vscode-editor-font-family, monospace); }

  /* UWP-style buttons */
  button { background: transparent; color: var(--fg); border: 1px solid var(--border); padding: 5px 14px; cursor: pointer; font: inherit; white-space: nowrap; }
  button:hover { background: var(--win-accent); border-color: var(--win-accent); color: #fff; }
  button.primary { background: var(--win-accent); border-color: var(--win-accent); color: #fff; }
  button.primary:hover { background: var(--win-accent-hover); border-color: var(--win-accent-hover); }
  button.danger { background: transparent; border-color: var(--win-err-dark); color: var(--win-err); }
  button.danger:hover { background: var(--win-err-dark); border-color: var(--win-err-dark); color: #fff; }
  button.small { padding: 3px 9px; font-size: 11.5px; }
  button:disabled { opacity: 0.45; cursor: default; }
  button:disabled:hover { background: transparent; border-color: var(--border); color: var(--fg); }
  button.primary:disabled:hover { background: var(--win-accent); border-color: var(--win-accent); color: #fff; }

  .label { color: var(--muted); font-size: 11.5px; margin: 8px 0 3px; }
  .muted { color: var(--muted); }
  .small { font-size: 11.5px; }
  .badge { display: inline-block; padding: 2px 8px; font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid var(--border); }
  .badge.idle { color: var(--muted); }
  .badge.starting { color: var(--win-warn); border-color: var(--win-warn); }
  .badge.running { color: var(--win-ok); border-color: var(--win-ok); }
  .badge.error { color: var(--win-err); border-color: var(--win-err); }
  .hint { font-size: 11.5px; color: var(--muted); margin-top: 8px; }
  .warn-box { border: 1px solid var(--win-warn); border-left: 3px solid var(--win-warn); background: rgba(255,185,0,0.07); padding: 8px 10px; font-size: 12px; }

  /* Provider list — Win10 Settings nav style: left accent bar when selected */
  .provider-list { display: grid; gap: 4px; margin-top: 6px; }
  .prov { border: 1px solid var(--border); border-left: 3px solid transparent; padding: 8px 10px; cursor: pointer; background: transparent; }
  .prov:hover { border-color: var(--win-accent); }
  .prov.active { border-color: var(--win-accent); border-left: 3px solid var(--win-accent); background: rgba(0,120,212,0.10); }
  .prov.disabled { cursor: not-allowed; opacity: 0.55; }
  .prov.disabled.active { opacity: 0.8; }
  .prov h3 { margin: 0 0 2px; font-size: 12.5px; font-weight: 600; }
  .prov p { margin: 0; color: var(--muted); font-size: 11.5px; }

  pre.cmd { background: var(--input); padding: 8px 10px; overflow: auto; font-size: 11.5px; white-space: pre-wrap; word-break: break-all; margin: 4px 0; font-family: var(--vscode-editor-font-family, Consolas, monospace); }
  ul.tools { list-style: none; padding: 0; margin: 4px 0 0; }
  ul.tools li { padding: 4px 0; border-bottom: 1px solid var(--border); }
  ul.tools li:last-child { border-bottom: none; }
  ul.tools .tname { font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 12px; font-weight: 600; color: var(--win-accent); }
  ul.tools .tdesc { color: var(--muted); font-size: 11.5px; }
  pre.log { background: var(--input); padding: 8px 10px; max-height: 180px; overflow: auto; font-size: 11px; white-space: pre-wrap; word-break: break-all; font-family: var(--vscode-editor-font-family, Consolas, monospace); }
  label.check { display: flex; align-items: center; gap: 7px; font-size: 12.5px; cursor: pointer; }
  input[type=checkbox] { accent-color: var(--win-accent); }

  /* Error-advice card: what happened + how to fix it */
  .advice { display: none; border: 1px solid var(--win-err); border-left: 3px solid var(--win-err); background: rgba(232,17,35,0.08); padding: 9px 11px; margin-top: 8px; font-size: 12px; }
  .advice.show { display: block; }
  .advice .advice-code { display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; color: #fff; background: var(--win-err); padding: 1px 6px; margin-right: 6px; vertical-align: 1px; }
  .advice .advice-title { font-weight: 600; color: var(--win-err); margin-bottom: 4px; }
  .advice .advice-sol { white-space: pre-wrap; word-break: break-word; }
  .advice .advice-sol b { color: var(--fg); }
  .advice a { color: var(--win-accent); text-decoration: none; }
  .advice a:hover { text-decoration: underline; }

  /* Prompt templates */
  .tpl { border: 1px solid var(--border); padding: 8px 10px; margin-bottom: 6px; background: var(--bg); }
  .tpl .tpl-head { display: flex; align-items: center; gap: 6px; }
  .tpl .tpl-name { font-weight: 600; font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tpl .tpl-urltag { flex: none; font-size: 10px; color: var(--win-ok); border: 1px solid var(--win-ok); padding: 0 5px; }
  .tpl .tpl-urltag.nourl { color: var(--win-warn); border-color: var(--win-warn); }
  .tpl .tpl-preview { color: var(--muted); font-size: 11.5px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; max-height: 66px; overflow: hidden; }
  .tpl .row button { flex: none; }
</style>
</head>
<body>
  <h1>${t("settings.heading")} <span class="led" id="headLed"></span><span id="badge" class="badge idle">${t("state.idle")}</span></h1>
  <div class="sub" id="endpointLine">${t("settings.notRunning")}</div>

  <div class="card">
    <div class="row">
      <input id="url" type="text" readonly placeholder="${t("settings.placeholderUrl")}" />
      <button id="copyUrlBtn" class="small" title="${t("settings.copyUrl")}">&#128203;</button>
    </div>
    <div class="row" style="margin-top:8px;">
      <span class="spacer" style="flex:1;"></span>
      <button id="startBtn" class="primary">${t("settings.start")}</button>
      <button id="stopBtn" class="danger">${t("settings.stop")}</button>
    </div>
    <div class="hint">${t("settings.hintShare")}</div>
    <div class="advice" id="adviceBox">
      <div class="advice-title"><span class="advice-code" id="adviceCode" style="display:none;"></span><span id="adviceTitle"></span></div>
      <div class="advice-sol"><b>${t("advice.solution")}:</b> <span id="adviceSol"></span></div>
      <div class="row" style="margin-top:6px;">
        <a id="adviceLink" href="#" style="flex:none; display:none;">${t("advice.openDocs")} &#8599;</a>
        <button id="adviceCopy" class="small" style="flex:none;">${t("advice.copySolution")}</button>
      </div>
    </div>
  </div>

  <h2>${t("settings.section.connection")}</h2>
  <div class="card">
    <div class="label">${t("settings.tunnelMode")}</div>
    <div class="provider-list" id="provList"></div>
    <div id="ngrokDomainBox" style="display:none;">
      <div class="label">${t("settings.ngrokDomain")}</div>
      <input id="ngrokDomain" type="text" placeholder="your-name.ngrok-free.dev" />
      <label class="check" style="margin-top:8px;"><input type="checkbox" id="ngrokPoolingEnabled" />${t("settings.ngrokPoolingEnabled")}</label>
      <div class="hint">${t("settings.ngrokPoolingHint")}</div>
    </div>
    <div id="cfDomainBox" style="display:none;">
      <div class="label">${t("settings.cfHostname")}</div>
      <input id="cfDomain" type="text" placeholder="bridge.example.com" />
      <div class="label">${t("settings.cfTunnelToken")}</div>
      <div class="row">
        <input id="cfTunnelToken" type="password" autocomplete="off" placeholder="${t("settings.cfTokenPlaceholder")}" />
        <button id="saveCfToken" class="small" style="flex:none;">${t("settings.saveSecret")}</button>
        <button id="clearCfToken" class="small" style="flex:none;">${t("settings.clearSecret")}</button>
      </div>
      <div id="cfTokenState" class="small muted" style="margin-top:4px;">${t("settings.cfTokenMissing")}</div>
      <div class="warn-box" style="margin-top:8px;">${t("settings.cfFixedPortHint")}</div>
    </div>
    <div id="customTunnelBox" style="display:none;">
      <div class="label">${t("settings.customCommand")}</div>
      <input id="customCommand" type="text" placeholder="cloudflared tunnel --url http://127.0.0.1:{{port}}" />
      <div class="label">${t("settings.customUrl")}</div>
      <input id="customUrl" type="text" placeholder="https://tunnel.example.com" />
      <div class="small muted" style="margin-top:4px;">${t("settings.customHint")}</div>
    </div>
    <div class="label">${t("settings.secretPath")}</div>
    <input id="routeToken" type="password" placeholder="/mcp/&lt;token&gt;" />
    <div class="label">${t("settings.localPort")}</div>
    <input id="localPort" type="number" min="0" max="65535" value="0" />
    <div class="row" style="margin-top:12px; gap:16px;">
      <label class="check" style="flex:1;"><input type="checkbox" id="startOnActivation" />${t("settings.autoStart")}</label>
      <label class="check" style="flex:1;"><input type="checkbox" id="showCommandsInTerminal" />${t("settings.showTerm")}</label>
    </div>
    <div class="label">${t("settings.tunnelStatus")}</div>
    <div class="row">
      <span class="small" id="diagState">${t("settings.detecting")}</span>
      <button id="refreshDiag" class="small" style="flex:none;">${t("settings.recheck")}</button>
    </div>
    <div class="small" id="cfVer">cloudflared: &mdash;</div>
    <div class="small" id="cfNamedDiag">${t("settings.cfNamedConfig")}: &mdash;</div>
    <div class="small" id="ngVer">ngrok: &mdash;</div>
    <div class="small muted" id="diagErr" style="margin-top:6px;"></div>
  </div>

  <h2>${t("settings.section.security")}</h2>
  <div class="card">
    <div class="row">
      <button id="resetRouteToken" class="danger small" style="flex:none;">${t("settings.resetAddress")}</button>
      <span class="small muted">${t("settings.resetHint")}</span>
    </div>
  </div>

  <h2>${t("settings.section.agentInstructions")}</h2>
  <div class="card">
    <div class="small muted">${t("settings.agentInstructionsHint")}</div>
    <textarea id="agentInstructions" style="margin-top:8px; min-height:160px;" placeholder="${t("settings.agentInstructionsPlaceholder")}"></textarea>
    <div class="row" style="margin-top:8px;">
      <button id="saveInstructions" class="primary small" style="flex:none;">${t("settings.saveInstructions")}</button>
    </div>
  </div>

  <h2>${t("prompt.sectionTitle")}</h2>
  <div class="card">
    <div class="small muted">${t("prompt.hint")}</div>
    <div id="promptList" style="margin-top:8px;"></div>
    <div class="label">${t("prompt.nameLabel")}</div>
    <input id="promptName" type="text" maxlength="60" placeholder="${t("prompt.namePlaceholder")}" />
    <div class="label">${t("prompt.templateLabel")}</div>
    <textarea id="promptText" placeholder="${t("prompt.templatePlaceholder")}"></textarea>
    <div class="row" style="margin-top:8px;">
      <button id="promptSave" class="primary small" style="flex:none;">${t("prompt.add")}</button>
      <button id="promptCancel" class="small" style="flex:none; display:none;">${t("prompt.cancel")}</button>
    </div>
  </div>

  <h2>${t("settings.section.tools")}</h2>
  <div class="card">
    <div class="small muted">${t("settings.toolsHint")}</div>
    <ul class="tools" id="toolList"></ul>
  </div>

  <h2>${t("settings.section.diagnostics")}</h2>
  <div class="card">
    <div class="row"><span>${t("settings.title")}</span><span class="small" id="sessionState">&mdash;</span><button id="showLog" class="small" style="flex:none;">${t("settings.openLog")}</button></div>
    <pre class="log" id="log" style="margin-top:8px;"></pre>
  </div>

  <div class="row" style="margin-top:16px;">
    <button id="openSettingsJson" class="small" style="flex:none;">${t("settings.openVscodeSettings")}</button>
    <span class="small muted">${t("settings.settingsHint")}</span>
  </div>

  <script>
    ${webviewL10nScript()}
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    let state = { kind: 'idle' };
    let latestConfig = null;
    let promptsData = { templates: [], url: undefined };
    let editingIdx = -1;

    // Replace {url} with the live URL; keep the token visible when unknown.
    const renderTpl = (text, url) => url ? text.replace(/\\{url\\}/gi, url) : text;
    const needsUrl = (text) => /\\{url\\}/i.test(text);

    const PROVIDERS = [
      { id: 'ngrok-reserved', name: t('provider.ngrok-reserved.name'), desc: t('provider.ngrok-reserved.desc') },
      { id: 'cloudflare-quick', name: t('provider.cloudflare-quick.name'), desc: t('provider.cloudflare-quick.desc') },
      { id: 'cloudflare-named', name: t('provider.cloudflare-named.name'), desc: t('provider.cloudflare-named.desc') },
      { id: 'custom', name: t('provider.custom.name'), desc: t('provider.custom.desc') }
    ];

    function kindLabel(k) {
      return k === 'running' ? t('state.running') : k === 'error' ? t('state.error') : k === 'starting' ? t('state.starting') : t('state.idle');
    }

    function renderProviders(active, cfg) {
      const root = $('provList'); root.innerHTML = '';
      const locked = state.kind === 'starting' || state.kind === 'running';
      for (const p of PROVIDERS) {
        const div = document.createElement('div');
        div.className = 'prov' + (p.id === active ? ' active' : '') + (locked ? ' disabled' : '');
        div.innerHTML = '<h3>' + esc(p.name) + '</h3><p>' + esc(p.desc) + '</p>';
        if (locked) {
          div.title = t('msg.providerLocked');
          div.setAttribute('aria-disabled', 'true');
        } else {
          div.addEventListener('click', () => vscode.postMessage({ type: 'setProvider', provider: p.id }));
        }
        root.appendChild(div);
      }
      $('ngrokDomainBox').style.display = (active === 'ngrok-reserved') ? '' : 'none';
      $('cfDomainBox').style.display = (active === 'cloudflare-named') ? '' : 'none';
      $('customTunnelBox').style.display = (active === 'custom') ? '' : 'none';
      if (cfg) {
        $('ngrokDomain').value = cfg.ngrokDomain || '';
        $('ngrokPoolingEnabled').checked = !!cfg.ngrokPoolingEnabled;
        $('cfDomain').value = cfg.cloudflareDomain || '';
        $('customCommand').value = cfg.customTunnelCommand || '';
        $('customUrl').value = cfg.customTunnelUrl || '';
        $('cfTokenState').textContent = cfg.cloudflareTunnelTokenSet ? t('settings.cfTokenStored') : t('settings.cfTokenMissing');
        $('cfTokenState').style.color = cfg.cloudflareTunnelTokenSet ? 'var(--win-ok)' : 'var(--win-warn)';
        $('routeToken').value = cfg.routeToken || '';
        $('localPort').value = cfg.localPort || 0;
        $('startOnActivation').checked = !!cfg.startOnActivation;
        $('showCommandsInTerminal').checked = cfg.showCommandsInTerminal !== false;
        $('agentInstructions').value = cfg.agentInstructions || '';
      }
    }

    function setState(s) {
      state = s;
      const badge = $('badge');
      badge.className = 'badge ' + s.kind;
      badge.textContent = kindLabel(s.kind);
      const led = $('headLed');
      led.className = 'led ' + (s.kind === 'running' ? 'ok' : s.kind === 'starting' ? 'starting' : s.kind === 'error' ? 'error' : '');
      $('url').value = (s.kind === 'running') ? s.publicUrl : (s.kind === 'error' ? t('settings.errorPrefix', s.message) : '');
      $('endpointLine').textContent = (s.kind === 'running')
        ? t('settings.endpointOpen', s.publicUrl)
        : (s.kind === 'error' ? t('settings.errorPrefix', s.message) : t('settings.endpointDown'));
      $('startBtn').disabled = (s.kind === 'starting' || s.kind === 'running');
      $('stopBtn').disabled = (s.kind !== 'running' && s.kind !== 'error');
      $('sessionState').textContent = kindLabel(s.kind);
      renderAdvice(s);
      if (latestConfig) renderProviders(latestConfig.tunnelProvider, latestConfig);
    }

    // Error doctor: show a "what happened / how to fix it" card when Portal
    // recognized the failure.
    let lastAdvice = null;
    function renderAdvice(s) {
      const box = $('adviceBox');
      lastAdvice = (s && s.kind === 'error' && s.advice) ? s.advice : null;
      box.className = 'advice' + (lastAdvice ? ' show' : '');
      if (!lastAdvice) return;
      $('adviceCode').style.display = lastAdvice.code ? '' : 'none';
      $('adviceCode').textContent = lastAdvice.code || '';
      $('adviceTitle').textContent = lastAdvice.title || '';
      $('adviceSol').textContent = lastAdvice.solution || '';
      const link = $('adviceLink');
      if (lastAdvice.link) {
        link.style.display = '';
        link.textContent = t('advice.openDocs') + ' \\u2197';
        link.href = lastAdvice.link;
      } else {
        link.style.display = 'none';
      }
    }

    function renderPrompts() {
      const list = $('promptList'); list.innerHTML = '';
      if (!promptsData.templates.length) {
        list.innerHTML = '<div class="small muted">' + esc(t('prompt.empty')) + '</div>';
      }
      promptsData.templates.forEach((tpl, i) => {
        const div = document.createElement('div');
        div.className = 'tpl';
        const preview = renderTpl(tpl.text, promptsData.url);
        div.innerHTML =
          '<div class="tpl-head">' +
            '<span class="tpl-name">' + esc(tpl.name) + '</span>' +
            '<span class="tpl-urltag' + (promptsData.url ? '' : ' nourl') + '" title="' + esc(needsUrl(tpl.text) ? t('prompt.needsUrl') : t('prompt.staticTip')) + '">' +
              esc(needsUrl(tpl.text) ? (promptsData.url ? '{url}\\u2192\\u2713' : '{url}?') : '\\u2014') + '</span>' +
            '<button class="small" data-act="copy">' + esc(t('prompt.copy')) + '</button>' +
            '<button class="small" data-act="edit">' + esc(t('prompt.edit')) + '</button>' +
            '<button class="small danger" data-act="del">' + esc(t('prompt.delete')) + '</button>' +
          '</div>' +
          '<div class="tpl-preview">' + esc(preview.length > 240 ? preview.slice(0, 239) + '\\u2026' : preview) + '</div>';
        div.querySelector('[data-act=copy]').addEventListener('click', () => {
          if (needsUrl(tpl.text) && !promptsData.url) { vscode.postMessage({ type: 'warnStartFirst' }); return; }
          vscode.postMessage({ type: 'copyText', text: renderTpl(tpl.text, promptsData.url) });
        });
        div.querySelector('[data-act=edit]').addEventListener('click', () => startEdit(i));
        div.querySelector('[data-act=del]').addEventListener('click', () => {
          vscode.postMessage({ type: 'deletePrompt', index: i });
          if (editingIdx === i) resetPromptForm();
        });
        list.appendChild(div);
      });
    }

    function startEdit(i) {
      editingIdx = i;
      const tpl = promptsData.templates[i];
      $('promptName').value = tpl.name;
      $('promptText').value = tpl.text;
      $('promptSave').textContent = t('prompt.update');
      $('promptCancel').style.display = '';
      $('promptName').focus();
    }
    function resetPromptForm() {
      editingIdx = -1;
      $('promptName').value = '';
      $('promptText').value = '';
      $('promptSave').textContent = t('prompt.add');
      $('promptCancel').style.display = 'none';
    }

    function setDiag(d) {
      if (!d) { $('diagState').textContent = t('settings.notDetected'); return; }
      $('diagState').textContent = t('settings.detected');
      $('cfVer').innerHTML = 'cloudflared: ' + (d.cloudflaredInstalled ? '\\u2705 ' + esc(d.cloudflaredVersion || '') : '\\u274c ' + esc(t('settings.notInstalled'))) +
        ' <button class="small" id="cfInstall">' + esc(d.cloudflaredInstalled ? t('settings.reinstall') : t('settings.install')) + '</button>';
      const cfIssue = !d.cloudflaredInstalled ? t('settings.notInstalled') : !d.cloudflareTunnelTokenSet ? t('settings.cfTokenMissing') : !d.cloudflareDomain ? t('settings.cfHostname') : !d.cloudflareNamedReady ? t('settings.localPort') : t('settings.configReady');
      $('cfNamedDiag').textContent = t('settings.cfNamedConfig') + ': ' + (d.cloudflareNamedReady ? '\\u2705 ' : '\\u26a0\\ufe0f ') + cfIssue;
      $('ngVer').innerHTML = 'ngrok: ' + (!d.ngrokInstalled ? '\\u274c ' + esc(t('settings.notInstalled')) : (!d.ngrokConfigValid ? '\\u26a0\\ufe0f ' + esc(t('settings.authtokenMissing')) : '\\u2705 ' + esc(d.ngrokVersion || ''))) +
        ' <button class="small" id="ngInstall">' + esc(t('settings.install')) + '</button>';
      $('diagErr').textContent = d.lastError || '';
      const cfi = document.getElementById('cfInstall');
      const ngi = document.getElementById('ngInstall');
      if (cfi) cfi.addEventListener('click', () => vscode.postMessage({ type: 'installCloudflared' }));
      if (ngi) ngi.addEventListener('click', () => vscode.postMessage({ type: 'installNgrok' }));
    }

    function setLogs(logs) {
      $('log').textContent = (logs || []).map((e) =>
        '[' + new Date(e.ts).toLocaleTimeString() + '] ' + e.level.toUpperCase() + ' ' + e.message
      ).join('\\n');
      $('log').scrollTop = $('log').scrollHeight;
    }

    function setTools(tools) {
      const ul = $('toolList'); ul.innerHTML = '';
      for (const tool of tools) {
        const li = document.createElement('li');
        li.innerHTML = '<div class="tname">' + esc(tool.name) + '</div><div class="tdesc">' + esc(tool.description) + '</div>';
        ul.appendChild(li);
      }
    }

    $('startBtn').addEventListener('click', () => vscode.postMessage({ type: 'start' }));
    $('stopBtn').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    $('copyUrlBtn').addEventListener('click', () => vscode.postMessage({ type: 'copyUrl' }));
    $('refreshDiag').addEventListener('click', () => vscode.postMessage({ type: 'refreshDiag' }));
    $('ngrokDomain').addEventListener('change', (e) => vscode.postMessage({ type: 'setNgrokDomain', domain: e.target.value }));
    $('ngrokPoolingEnabled').addEventListener('change', (e) => vscode.postMessage({ type: 'setNgrokPoolingEnabled', value: e.target.checked }));
    $('cfDomain').addEventListener('change', (e) => vscode.postMessage({ type: 'setCloudflareDomain', domain: e.target.value }));
    $('customCommand').addEventListener('change', (e) => vscode.postMessage({ type: 'setCustomTunnelCommand', command: e.target.value }));
    $('customUrl').addEventListener('change', (e) => vscode.postMessage({ type: 'setCustomTunnelUrl', url: e.target.value }));
    $('saveCfToken').addEventListener('click', () => vscode.postMessage({ type: 'saveCloudflareTunnelToken', token: $('cfTunnelToken').value }));
    $('clearCfToken').addEventListener('click', () => vscode.postMessage({ type: 'clearCloudflareTunnelToken' }));
    $('routeToken').addEventListener('change', (e) => vscode.postMessage({ type: 'setRouteToken', token: e.target.value }));
    $('localPort').addEventListener('change', (e) => vscode.postMessage({ type: 'setLocalPort', port: e.target.value }));
    $('startOnActivation').addEventListener('change', (e) => vscode.postMessage({ type: 'setStartOnActivation', value: e.target.checked }));
    $('showCommandsInTerminal').addEventListener('change', (e) => vscode.postMessage({ type: 'setShowCommandsInTerminal', value: e.target.checked }));
    $('resetRouteToken').addEventListener('click', () => vscode.postMessage({ type: 'resetRouteToken' }));
    $('showLog').addEventListener('click', () => vscode.postMessage({ type: 'showLog' }));
    $('openSettingsJson').addEventListener('click', () => vscode.postMessage({ type: 'openSettingsJson' }));
    $('saveInstructions').addEventListener('click', () => vscode.postMessage({ type: 'setAgentInstructions', value: $('agentInstructions').value }));
    $('promptSave').addEventListener('click', () => {
      const name = $('promptName').value.trim();
      const text = $('promptText').value.trim();
      if (!text) return;
      if (editingIdx >= 0) vscode.postMessage({ type: 'updatePrompt', index: editingIdx, name, text });
      else vscode.postMessage({ type: 'addPrompt', name, text });
      resetPromptForm();
    });
    $('promptCancel').addEventListener('click', resetPromptForm);
    $('adviceCopy').addEventListener('click', () => {
      if (!lastAdvice) return;
      const text = (lastAdvice.code ? lastAdvice.code + '\\n' : '') + (lastAdvice.title || '') + '\\n' + (lastAdvice.solution || '') + (lastAdvice.link ? '\\n' + lastAdvice.link : '');
      vscode.postMessage({ type: 'copyText', text });
    });
    $('adviceLink').addEventListener('click', (e) => {
      e.preventDefault();
      if (lastAdvice && lastAdvice.link) vscode.postMessage({ type: 'openExternal', url: lastAdvice.link });
    });

    window.addEventListener('message', (e) => {
      const m = e.data; if (!m) return;
      if (m.type === 'state') setState(m.state);
      if (m.type === 'config') { latestConfig = m.config; renderProviders(m.config.tunnelProvider, m.config); }
      if (m.type === 'diag') setDiag(m.diag);
      if (m.type === 'logs') setLogs(m.logs);
      if (m.type === 'tools') setTools(m.tools);
      if (m.type === 'prompts') { promptsData = { templates: m.templates || [], url: m.url }; renderPrompts(); }
    });
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
}
