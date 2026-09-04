/**
 * Sidebar webview (the 'Portal' view): live status LED, activity feed,
 * session stats and start/stop buttons. Win10-flavored flat UI: square
 * corners, Segoe UI, Win10 semantic colors. Talks to the extension host
 * purely via postMessage.
 */
import * as vscode from "vscode";
import { SessionHub } from "../session-hub";
import { getActiveProfileName, listProfiles, setActiveProfile } from "../profiles";
import { localeTag, t, webviewL10nScript } from "../nls";

// Mounted once by extension.ts; the webview HTML is static — all updates are pushed.
export class SidebarPanel implements vscode.WebviewViewProvider {
  public readonly viewId = "portal.panel";
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly bm: SessionHub) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = renderHtml();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.disposables.push(
      // State changes also re-push prompts: the embedded {url} follows the session.
      this.bm.onState(() => { this.push("state", { state: this.bm.getState() }); this.pushPrompts(); }),
      this.bm.onActivity(() => this.push("activity", { items: this.bm.getActivities() })),
      this.bm.onStats(() => this.push("stats", { stats: this.bm.getStats() })),
      webviewView.webview.onDidReceiveMessage((m) => this.handle(m)),
      // Profiles live in settings, so re-push them whenever a portal.* key changes.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("portal")) this.pushProfiles();
      }),
    );
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
      for (const d of this.disposables) d.dispose();
      this.disposables.length = 0;
    });
  }

  // Only send after the webview announced webviewReady (avoids queuing stale state).
  private push(type: string, payload: Record<string, unknown>): void {
    if (this.view && this.ready) this.view.webview.postMessage({ type, ...payload });
  }

  private pushPrompts(): void {
    this.push("prompts", this.bm.getPromptSnapshot());
  }

  private pushProfiles(): void {
    this.push("profiles", { profiles: listProfiles(), active: getActiveProfileName() });
  }

  private pushAll(): void {
    this.push("state", { state: this.bm.getState() });
    this.pushProfiles();
    this.push("activity", { items: this.bm.getActivities() });
    this.push("stats", { stats: this.bm.getStats() });
    this.push("tokens", { sessions: this.bm.listSessions(), active: this.bm.getActiveId() });
    this.pushPrompts();
  }

  // Messages from the webview: ready handshake + button clicks.
  private async handle(msg: any): Promise<void> {
    switch (msg?.type) {
      case "webviewReady": this.ready = true; this.pushAll(); break;
      case "start": await this.bm.start(); break;
      case "stop": await this.bm.stop(); break;
      case "openSettings": await vscode.commands.executeCommand("portal.showPanel"); break;
      case "selectToken": this.bm.setActive(String(msg.id)); this.pushAll(); break;
      case "restart": await this.bm.restart(); break;
      case "activateProfile": {
        const name = String(msg.name ?? "");
        const target = await setActiveProfile(name);
        if (target === vscode.ConfigurationTarget.Global) vscode.window.showWarningMessage(t("profile.noFolder"));
        this.pushProfiles();
        const st = this.bm.getState();
        const label = name || t("profile.defaultOption");
        if (st.kind === "running" || st.kind === "starting") {
          const answer = await vscode.window.showInformationMessage(t("profile.switchedRestart", label), t("profile.restartNow"));
          if (answer) await this.bm.restart();
        } else {
          vscode.window.showInformationMessage(t("profile.switched", label));
        }
        break;
      }
      case "copyText":
        await vscode.env.clipboard.writeText(String(msg.text ?? ""));
        vscode.window.showInformationMessage(t("msg.copied"));
        break;
      case "warnStartFirst": vscode.window.showInformationMessage(t("msg.startFirst")); break;
      case "openExternal": await vscode.env.openExternal(vscode.Uri.parse(String(msg.url))); break;
    }
  }
}

// Static webview shell: CSP allows inline style/script only; colors come from
// VS Code theme CSS variables. Win10 design language: no border-radius,
// Segoe UI, flat 1px borders, square status LEDs, UWP-style buttons.
function renderHtml(): string {
  return `<!doctype html>
<html lang="${localeTag()}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>${t("sidebar.title")}</title>
<style>
  :root {
    --bg: var(--vscode-sideBar-background, #1e1e1e);
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
  .tokenbar { display: flex; align-items: center; gap: 7px; margin: 0 10px 8px; flex: none; }
  .tokenbar .tokenlabel { font-size: 10.5px; color: var(--muted); letter-spacing: 0.05em; text-transform: uppercase; }
  .tokenbar .tsel { flex: 1; min-width: 0; background: var(--input); color: var(--fg); border: 1px solid var(--border); padding: 3px 6px; font: inherit; font-size: 11.5px; }
  .tokenbar .tsel:focus { outline: none; border-color: var(--win-accent); }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; font: 13px/1.45 "Segoe UI", "Microsoft YaHei UI", -apple-system, sans-serif; color: var(--fg); background: var(--bg); }

  /* Header — Win10 title-bar flavor */
  .header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); flex: none; background: var(--card); }
  .logo { width: 18px; height: 18px; color: var(--win-accent); flex: none; }
  .logo svg { width: 18px; height: 18px; }
  .title { font-size: 12px; font-weight: 600; letter-spacing: 0.12em; }
  .led { width: 10px; height: 10px; background: #808080; flex: none; }
  .led.ok { background: var(--win-ok); }
  .led.err { background: var(--win-err); }
  .led.warn { background: var(--win-warn); }
  .status { font-size: 11px; color: var(--muted); }
  .spacer { flex: 1; }
  .activeBadge { display: inline-flex; align-items: center; font-size: 10.5px; color: var(--muted); padding: 2px 6px; border: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .activeBadge.live { color: var(--win-ok); border-color: var(--win-ok); }
  .icon-btn { background: transparent; border: 1px solid transparent; color: var(--fg); width: 26px; height: 26px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: none; padding: 0; }
  .icon-btn:hover { border-color: var(--win-accent); color: var(--win-accent); }
  .icon-btn svg { width: 15px; height: 15px; }

  /* Activity feed */
  .feed { flex: 1; overflow-y: auto; padding: 0 10px; }
  .empty { color: var(--muted); font-size: 12px; padding: 14px 2px; text-align: center; }
  .item { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--vscode-tree-indentGuidesStroke, rgba(255,255,255,0.06)); }
  .item:last-child { border-bottom: none; }
  .item .ico { flex: none; width: 16px; height: 16px; margin-top: 1px; color: var(--muted); }
  .item .ico svg { width: 16px; height: 16px; }
  .item.err .ico { color: var(--win-err); }
  .body { flex: 1; min-width: 0; }
  .t { font-size: 12.5px; word-break: break-all; }
  .item.err .t { color: var(--win-err); }
  .d { font-size: 11px; color: var(--muted); margin-top: 1px; }
  .dur { flex: none; font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; padding-top: 2px; }

  /* Session card — flat, square */
  .session { margin: 0 10px 8px; border: 1px solid var(--border); background: var(--card); padding: 10px; flex: none; }
  .session .head { display: flex; align-items: center; gap: 7px; }
  .session .head b { font-size: 11px; letter-spacing: 0.08em; font-weight: 600; }
  .session .conn { font-size: 11.5px; color: var(--muted); margin-top: 6px; }
  .session .conn.live { color: var(--win-ok); }

  /* UWP-style buttons: square, flat, accent fill on hover */
  .btn { border: 1px solid var(--border); background: transparent; color: var(--fg); padding: 4px 12px; cursor: pointer; font: inherit; font-size: 11.5px; white-space: nowrap; }
  .btn:hover { background: var(--win-accent); border-color: var(--win-accent); color: #fff; }
  .btn.primary { background: var(--win-accent); border-color: var(--win-accent); color: #fff; }
  .btn.primary:hover { background: var(--win-accent-hover); border-color: var(--win-accent-hover); }
  .btn.danger { background: transparent; border-color: var(--win-err-dark); color: var(--win-err); }
  .btn.danger:hover { background: var(--win-err-dark); border-color: var(--win-err-dark); color: #fff; }

  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin-top: 10px; background: var(--border); border: 1px solid var(--border); }
  .stat { background: var(--bg); padding: 6px 8px; }
  .stat .k { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat .v { font-size: 14px; font-weight: 600; margin-top: 1px; font-variant-numeric: tabular-nums; }

  .footer { padding: 6px 10px; border-top: 1px solid var(--border); font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; background: var(--card); }

  /* Error-advice card — what happened + how to fix it */
  .advice { display: none; margin: 0 10px 8px; border: 1px solid var(--win-err); border-left: 3px solid var(--win-err); background: rgba(232,17,35,0.08); padding: 8px 10px; font-size: 11.5px; flex: none; }
  .advice.show { display: block; }
  .advice .advice-code { display: inline-block; font-size: 9.5px; font-weight: 600; letter-spacing: 0.05em; color: #fff; background: var(--win-err); padding: 0 5px; margin-right: 5px; vertical-align: 1px; }
  .advice .advice-title { font-weight: 600; color: var(--win-err); margin-bottom: 3px; word-break: break-word; }
  .advice .advice-sol { color: var(--fg); white-space: pre-wrap; word-break: break-word; max-height: 96px; overflow-y: auto; }
  .advice a { color: var(--win-accent); text-decoration: none; }
  .advice a:hover { text-decoration: underline; }

  /* Prompt quick-copy strip */
  .promptbar { display: none; gap: 6px; align-items: center; padding: 0 10px 8px; flex: none; }
  .promptbar.show { display: flex; }
  .psel { flex: 1; min-width: 0; background: var(--input); color: var(--fg); border: 1px solid var(--border); padding: 3px 4px; font: inherit; font-size: 11.5px; }
  .psel:focus { outline: none; border-color: var(--win-accent); }
  .psel.psel-sm { flex: none; max-width: 104px; }
  .runprofile { font-size: 10px; color: var(--muted); border: 1px solid var(--border); padding: 1px 4px; max-width: 116px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .runprofile.warn { color: var(--win-warn); border-color: var(--win-warn); }
  .runprofile.clickable { cursor: pointer; }
  .runprofile.clickable:hover { background: var(--win-warn); color: #000; }
  .promptbar .icon-btn { border: 1px solid var(--border); width: 24px; height: 24px; }
</style>
</head>
<body>
  <div class="header">
    <span class="logo"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.25 18.75V5.25h11.44v13.5H15V7.03H6.94v11.72Z"/><path d="M9.09 8.91h1.5v2.25h2.25V8.91h1.5v2.25h1.13v3.93h-2.63v2.81h-2.25v-2.81H7.97v-3.93h1.12Z"/></svg></span>
    <span class="title">PORTAL</span>
    <span class="led" id="statusDot"></span>
    <span class="status" id="statusText">${t("sidebar.idle")}</span>
    <span class="spacer"></span>
    <span class="activeBadge" id="activeBadge" title="${t("sidebar.activeRequests")}">0</span>
    <button class="icon-btn" id="settingsBtn" title="${t("sidebar.settings")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="16" height="16"/><path d="M4 9h16M9 4v16"/></svg>
    </button>
  </div>
  <div class="advice" id="adviceBox">
    <div class="advice-title"><span class="advice-code" id="adviceCode" style="display:none;"></span><span id="adviceTitle"></span></div>
    <div class="advice-sol" id="adviceSol"></div>
    <div style="display:flex; gap:6px; margin-top:6px; align-items:center;">
      <a id="adviceLink" href="#" style="display:none;">${t("advice.openDocs")} &#8599;</a>
      <button class="btn" id="adviceCopy" style="padding:2px 8px; font-size:10.5px;">${t("advice.copySolution")}</button>
    </div>
  </div>
  <div class="feed" id="feed"><div class="empty">${t("sidebar.empty")}</div></div>
  <div class="promptbar" id="promptBar">
    <select class="psel" id="promptSel" title="${t("prompt.copyTip")}"></select>
    <button class="icon-btn" id="promptCopy" title="${t("prompt.copyTip")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/></svg>
    </button>
  </div>
  <div class="tokenbar">
    <span class="tokenlabel">${t("sidebar.session")}</span>
    <select id="tokenSel" class="tsel" title="${t("sidebar.sessionPick")}"></select>
  </div>
  <div class="session">
    <div class="head">
      <span class="led" id="connDot"></span><b>${t("sidebar.session")}</b>
      <span class="spacer"></span>
      <select class="psel psel-sm" id="profileSel" title="${t("sidebar.profile")}"></select>
      <span class="runprofile" id="runProfile" style="display:none;"></span>
      <button class="btn primary" id="toggleBtn">${t("sidebar.start")}</button>
    </div>
    <div class="conn" id="connText">${t("sidebar.stopped")}</div>
    <div class="stats">
      <div class="stat"><div class="k">${t("sidebar.stat.calls")}</div><div class="v" id="toolCalls">0</div></div>
      <div class="stat"><div class="k">${t("sidebar.stat.avg")}</div><div class="v" id="avgResp">&mdash;</div></div>
      <div class="stat"><div class="k">${t("sidebar.stat.failures")}</div><div class="v" id="failures">0</div></div>
      <div class="stat"><div class="k">${t("sidebar.stat.success")}</div><div class="v" id="successRate">&mdash;</div></div>
    </div>
  </div>
  <div class="footer" id="footer">Streamable HTTP</div>
  <script>
    ${webviewL10nScript()}
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    let state = { kind: 'idle' };
    let stats = { connected: false, toolCalls: 0, failures: 0, totalResponseMs: 0, activeRequests: 0, protocol: 'Streamable HTTP' };
    let promptsData = { templates: [], url: undefined };
    let profileData = { list: [], active: '' };
    let lastAdvice = null;

    const renderTpl = (text, url) => url ? text.replace(/\\{url\\}/gi, url) : text;
    const needsUrl = (text) => /\\{url\\}/i.test(text);

    const ICONS = {
      run_command: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="4.5" width="19" height="15"/><polyline points="6.5 9 10.5 12 6.5 15"/><line x1="12.5" y1="15" x2="17.5" y2="15"/></svg>',
      start_command: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="6 4 20 12 6 20"/></svg>',
      read_command: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 12a8 8 0 0 1 16 0"/><path d="M2 12h3l2-4 3 8 2-4h10"/></svg>',
      stop_command: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="6" width="12" height="12"/></svg>',
      file_transfer_info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 16V8l-4 4z"/><path d="M17 8v8l4-4z"/><path d="M3 12h4M17 12h4"/><path d="M12 3v18"/></svg>',
      file_http: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>',
      default: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="2 12 6 12 9 5 14 19 17 12 22 12"/></svg>'
    };
    const icon = (tool) => ICONS[tool] || ICONS.default;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmtMs = (ms) => ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
    const fmtTime = (ts) => new Date(ts).toTimeString().slice(0, 8);
    const kindLabel = (k) => k === 'running' ? t('sidebar.running') : k === 'error' ? t('sidebar.error') : k === 'starting' ? t('sidebar.starting') : t('sidebar.idle');

    function renderState(s) {
      state = s;
      const dot = $('statusDot');
      dot.className = 'led ' + (s.kind === 'running' ? 'ok' : s.kind === 'error' ? 'err' : s.kind === 'starting' ? 'warn' : '');
      $('statusText').textContent = kindLabel(s.kind);
      const running = s.kind === 'running' || s.kind === 'starting';
      const btn = $('toggleBtn');
      btn.textContent = running ? t('sidebar.stop') : t('sidebar.start');
      btn.className = 'btn ' + (running ? 'danger' : 'primary');
      renderConn();
      renderRunningProfile();
      renderAdvice(s);
    }
    // Error-doctor card, shown between the header and the feed on failure.
    function renderAdvice(s) {
      lastAdvice = (s && s.kind === 'error' && s.advice) ? s.advice : null;
      const box = $('adviceBox');
      box.className = 'advice' + (lastAdvice ? ' show' : '');
      if (!lastAdvice) return;
      $('adviceCode').style.display = lastAdvice.code ? '' : 'none';
      $('adviceCode').textContent = lastAdvice.code || '';
      $('adviceTitle').textContent = lastAdvice.title || '';
      $('adviceSol').textContent = (t('advice.solution') + ': ' + (lastAdvice.solution || ''));
      const link = $('adviceLink');
      if (lastAdvice.link) {
        link.style.display = '';
        link.href = lastAdvice.link;
      } else link.style.display = 'none';
    }
    // Quick-copy strip: select a template, one click copies it with the live URL.
    function renderPrompts() {
      const bar = $('promptBar');
      const sel = $('promptSel');
      if (!promptsData.templates.length) { bar.className = 'promptbar'; sel.innerHTML = ''; return; }
      bar.className = 'promptbar show';
      const prev = sel.selectedIndex;
      sel.innerHTML = promptsData.templates.map((tpl) => {
        const flag = needsUrl(tpl.text) && !promptsData.url ? ' \\u26a0' : '';
        return '<option value="' + esc(tpl.name) + '">' + esc(tpl.name + flag) + '</option>';
      }).join('');
      if (prev >= 0 && prev < sel.options.length) sel.selectedIndex = prev;
    }
    function copySelectedPrompt() {
      const tpl = promptsData.templates[$('promptSel').selectedIndex];
      if (!tpl) return;
      if (needsUrl(tpl.text) && !promptsData.url) { vscode.postMessage({ type: 'warnStartFirst' }); return; }
      vscode.postMessage({ type: 'copyText', text: renderTpl(tpl.text, promptsData.url) });
    }
    function renderActivity(items) {
      const feed = $('feed');
      if (!items || !items.length) { feed.innerHTML = '<div class="empty">' + esc(t('sidebar.emptyHint')) + '</div>'; return; }
      feed.innerHTML = items.map((it) =>
        '<div class="item' + (it.ok ? '' : ' err') + '">' +
          '<div class="ico">' + icon(it.tool) + '</div>' +
          '<div class="body"><div class="t">' + esc(it.title) + '</div><div class="d">' + esc(it.detail) + '</div></div>' +
          '<div class="dur">' + fmtMs(it.durationMs) + '</div>' +
        '</div>'
      ).join('');
      feed.scrollTop = feed.scrollHeight;
    }
    // Profile picker + the profile the current session actually started with.
    function renderProfiles(d) {
      profileData = { list: (d && d.profiles) || [], active: (d && d.active) || '' };
      const sel = $('profileSel');
      sel.innerHTML = '<option value="">' + esc(t('profile.defaultOption')) + '</option>' +
        profileData.list.map((p) => '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>').join('');
      sel.value = profileData.active;
      sel.style.display = profileData.list.length ? '' : 'none';
      renderRunningProfile();
    }
    function renderRunningProfile() {
      const el = $('runProfile');
      if (state.kind !== 'running' && state.kind !== 'starting') { el.style.display = 'none'; el.textContent = ''; return; }
      el.style.display = '';
      const running = state.profileName || '';
      const selected = profileData.active || '';
      if (running && running !== selected) {
        const msg = t('profile.stale', running, selected || t('profile.defaultOption'));
        el.textContent = msg; el.title = msg + ' \\u00b7 ' + t('profile.restartNow'); el.className = 'runprofile warn clickable';
      } else {
        el.textContent = running ? t('profile.runningAs', running) : t('profile.runningDefault');
        el.title = el.textContent; el.className = 'runprofile';
      }
    }

    function renderConn() {
      const live = stats.connected;
      const running = state.kind === 'running' || state.kind === 'starting';
      $('connDot').className = 'led ' + (live ? 'ok' : '');
      const el = $('connText');
      el.textContent = live ? t('sidebar.connected') : running ? t('sidebar.waiting') : t('sidebar.stopped');
      el.className = 'conn' + (live ? ' live' : '');
    }
    function renderStats(s) {
      stats = s;
      $('toolCalls').textContent = s.toolCalls;
      $('avgResp').textContent = s.toolCalls ? fmtMs(s.totalResponseMs / s.toolCalls) : '\\u2014';
      $('failures').textContent = s.failures;
      $('successRate').textContent = s.toolCalls ? Math.round((s.toolCalls - s.failures) / s.toolCalls * 100) + '%' : '\\u2014';
      const badge = $('activeBadge');
      badge.textContent = s.activeRequests;
      badge.className = 'activeBadge' + (s.activeRequests > 0 ? ' live' : '');
      renderConn();
      renderFooter();
    }
    function renderFooter() {
      const last = stats.lastTool ? t('sidebar.footer.lastTool', stats.lastTool) + (stats.lastToolAt ? ' \\u00b7 ' + fmtTime(stats.lastToolAt) : '') : '';
      $('footer').textContent = stats.protocol + (last ? ' \\u00b7 ' + last : '');
    }
    function renderTokens(sessions, active) {
      const sel = $('tokenSel');
      if (!sessions || !sessions.length) {
        sel.innerHTML = '<option value="default">' + esc(t('session.defaultLabel')) + '</option>';
        sel.value = 'default';
        return;
      }
      sel.innerHTML = sessions.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>').join('');
      sel.value = active || '';
    }
    $('runProfile').addEventListener('click', () => {
      if ($('runProfile').className.indexOf('warn') >= 0) vscode.postMessage({ type: 'restart' });
    });
    $('tokenSel').addEventListener('change', (ev) => vscode.postMessage({ type: 'selectToken', id: ev.target.value }));
    $('settingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    $('toggleBtn').addEventListener('click', () => {
      const running = state.kind === 'running' || state.kind === 'starting';
      vscode.postMessage({ type: running ? 'stop' : 'start' });
    });
    $('profileSel').addEventListener('change', (e) => vscode.postMessage({ type: 'activateProfile', name: e.target.value }));
    $('promptCopy').addEventListener('click', copySelectedPrompt);
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
      if (m.type === 'state') renderState(m.state);
      if (m.type === 'activity') renderActivity(m.items);
      if (m.type === 'stats') renderStats(m.stats);
      if (m.type === 'profiles') renderProfiles(m);
      if (m.type === 'tokens') renderTokens(m.sessions, m.active);
      if (m.type === 'prompts') { promptsData = { templates: m.templates || [], url: m.url }; renderPrompts(); }
    });
    setInterval(renderFooter, 1000);
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
}
