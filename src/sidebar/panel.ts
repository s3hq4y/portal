/**
 * Sidebar webview (the 'Portal' view): live status LED, activity feed,
 * session stats and start/stop buttons. Win10-flavored flat UI: square
 * corners, Segoe UI, Win10 semantic colors. Talks to the extension host
 * purely via postMessage.
 */
import * as vscode from "vscode";
import { BridgeManager } from "../bridge-manager";
import { localeTag, t, webviewL10nScript } from "../nls";

// Mounted once by extension.ts; the webview HTML is static — all updates are pushed.
export class SidebarPanel implements vscode.WebviewViewProvider {
  public readonly viewId = "portal.panel";
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly bm: BridgeManager) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = renderHtml();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.disposables.push(
      this.bm.onState(() => this.push("state", { state: this.bm.getState() })),
      this.bm.onActivity(() => this.push("activity", { items: this.bm.getActivities() })),
      this.bm.onStats(() => this.push("stats", { stats: this.bm.getStats() })),
      webviewView.webview.onDidReceiveMessage((m) => this.handle(m)),
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

  private pushAll(): void {
    this.push("state", { state: this.bm.getState() });
    this.push("activity", { items: this.bm.getActivities() });
    this.push("stats", { stats: this.bm.getStats() });
  }

  // Messages from the webview: ready handshake + button clicks.
  private async handle(msg: any): Promise<void> {
    switch (msg?.type) {
      case "webviewReady": this.ready = true; this.pushAll(); break;
      case "start": await this.bm.start(); break;
      case "stop": await this.bm.stop(); break;
      case "openSettings": await vscode.commands.executeCommand("portal.showPanel"); break;
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
</style>
</head>
<body>
  <div class="header">
    <span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3v4a6 6 0 0 1 6 6h4"/><path d="M15 21v-4a6 6 0 0 1-6-6H5"/><rect x="3" y="3" width="4" height="4"/><rect x="17" y="17" width="4" height="4"/></svg></span>
    <span class="title">PORTAL</span>
    <span class="led" id="statusDot"></span>
    <span class="status" id="statusText">${t("sidebar.idle")}</span>
    <span class="spacer"></span>
    <span class="activeBadge" id="activeBadge" title="${t("sidebar.activeRequests")}">0</span>
    <button class="icon-btn" id="settingsBtn" title="${t("sidebar.settings")}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="16" height="16"/><path d="M4 9h16M9 4v16"/></svg>
    </button>
  </div>
  <div class="feed" id="feed"><div class="empty">${t("sidebar.empty")}</div></div>
  <div class="session">
    <div class="head">
      <span class="led" id="connDot"></span><b>${t("sidebar.session")}</b>
      <span class="spacer"></span>
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
    $('settingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    $('toggleBtn').addEventListener('click', () => {
      const running = state.kind === 'running' || state.kind === 'starting';
      vscode.postMessage({ type: running ? 'stop' : 'start' });
    });
    window.addEventListener('message', (e) => {
      const m = e.data; if (!m) return;
      if (m.type === 'state') renderState(m.state);
      if (m.type === 'activity') renderActivity(m.items);
      if (m.type === 'stats') renderStats(m.stats);
    });
    setInterval(renderFooter, 1000);
    vscode.postMessage({ type: 'webviewReady' });
  </script>
</body>
</html>`;
}
