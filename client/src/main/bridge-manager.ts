/**
 * BridgeManager — the heart of the app.
 *
 * Owns the full lifecycle of one bridge session:
 *   1. an McpHttpServer bound to 127.0.0.1 (JSON-RPC over Streamable HTTP
 *      plus the /files/<token> transfer API)
 *   2. a public tunnel (ngrok / cloudflared / custom) forwarding to that server
 *   3. session statistics + a rolling activity feed consumed by the UI
 */
import { ActivityItem, BridgeState, ErrorAdvice, LogEntry, PromptTemplate, SessionStats, TunnelDiagnostics } from "../shared/types";
import { settingsStore, type PortalConfig } from "./settings-store";
import { getCloudflareToken } from "./secrets";
import { generateRouteToken, McpHttpServer } from "./mcp-server";
import { ToolDescriptor, ToolExecutor } from "./tool-executor";
import { adviceForError, matchKnownError } from "./error-doctor";
import { currentPublicUrl } from "./prompts";
import {
  detectCloudflared,
  detectNgrok,
  startNgrok,
  startCloudflaredQuick,
  startCloudflaredNamed,
  startCustomTunnel,
  RunningTunnel,
} from "./tunnel";
import { AgentTerminalHost } from "./agent-terminal";
import { Logger } from "./logger";
import { t } from "./i18n";
import { resolveWorkspacePath, type ResolvedWorkspace } from "./workspace-host";

type StateListener = (s: BridgeState) => void;
type LogListener = (e: LogEntry) => void;
type DiagListener = (d: TunnelDiagnostics) => void;

export class BridgeManager {
  private mcp: McpHttpServer | undefined;
  private tunnel: RunningTunnel | undefined;
  private state: BridgeState = { kind: "idle" };
  private diagnostics: TunnelDiagnostics | null = null;
  private stateListeners = new Set<StateListener>();
  private logListeners = new Set<LogListener>();
  private diagListeners = new Set<DiagListener>();
  private readonly agentTerm: AgentTerminalHost;

  private activities: ActivityItem[] = [];
  private stats: SessionStats = {
    connected: false,
    toolCalls: 0,
    failures: 0,
    totalResponseMs: 0,
    activeRequests: 0,
    protocol: "Streamable HTTP",
  };
  private activityListeners = new Set<(a: readonly ActivityItem[]) => void>();
  private statsListeners = new Set<(s: SessionStats) => void>();
  private activitySeq = 0;
  private workspaceRoot: string | undefined;
  private workspaceInfo: ResolvedWorkspace | undefined;

  constructor(private readonly logger: Logger) {
    this.agentTerm = new AgentTerminalHost(() => settingsStore.readConfig().showCommandsInTerminal);
  }

  getState(): BridgeState {
    return this.state;
  }
  getDiagnostics(): TunnelDiagnostics | null {
    return this.diagnostics;
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }
  onLog(fn: LogListener): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }
  onDiagnostics(fn: DiagListener): () => void {
    this.diagListeners.add(fn);
    fn(this.diagnostics as TunnelDiagnostics);
    return () => this.diagListeners.delete(fn);
  }

  getActivities(): readonly ActivityItem[] {
    return this.activities;
  }
  getStats(): SessionStats {
    return this.stats;
  }
  getExposedTools(): ToolDescriptor[] {
    return new ToolExecutor(this.workspaceRoot ?? process.cwd()).listTools();
  }
  getPromptSnapshot(): { templates: PromptTemplate[]; url?: string } {
    const cfg = settingsStore.readConfig();
    return { templates: cfg.promptTemplates, url: currentPublicUrl(cfg, this.state) };
  }
  onActivity(fn: (a: readonly ActivityItem[]) => void): () => void {
    this.activityListeners.add(fn);
    fn(this.activities);
    return () => this.activityListeners.delete(fn);
  }
  onStats(fn: (s: SessionStats) => void): () => void {
    this.statsListeners.add(fn);
    fn(this.stats);
    return () => this.statsListeners.delete(fn);
  }
  onTerminalLine(fn: (line: import("../shared/ipc").TerminalLine) => void): () => void {
    return this.agentTerm.onLine(fn);
  }

  async refreshDiagnostics(): Promise<TunnelDiagnostics> {
    const cfg = settingsStore.readConfig();
    const [cf, ng, cloudflareToken] = await Promise.all([detectCloudflared(), detectNgrok(), getCloudflareToken()]);
    const cloudflareTunnelTokenSet = Boolean(cloudflareToken?.trim());
    this.diagnostics = {
      provider: cfg.tunnelProvider,
      cloudflaredInstalled: cf.installed,
      cloudflaredVersion: cf.version,
      cloudflareTunnelTokenSet,
      cloudflareDomain: cfg.cloudflareDomain || undefined,
      cloudflareNamedReady: cf.installed && cloudflareTunnelTokenSet && Boolean(cfg.cloudflareDomain) && cfg.localPort > 0,
      ngrokInstalled: ng.installed,
      ngrokVersion: ng.version,
      ngrokConfigValid: ng.configValid,
      ngrokDomain: cfg.ngrokDomain || undefined,
      lastError: cfg.tunnelProvider === "ngrok-reserved" ? ng.lastError : undefined,
    };
    for (const fn of this.diagListeners) fn(this.diagnostics);
    return this.diagnostics;
  }

  // Start: state machine goes idle -> starting -> running (or error).
  async start(): Promise<void> {
    const cfg = settingsStore.readConfig();
    if (this.state.kind === "running" || this.state.kind === "starting") return;
    this.setState({ kind: "starting", since: Date.now(), provider: cfg.tunnelProvider });
    this.log("info", t("log.starting", cfg.tunnelProvider));
    try {
      const folder = cfg.workspaceRoot.trim();
      if (!folder) throw new Error(t("err.noWorkspace"));
      const ws = resolveWorkspacePath(folder);
      this.workspaceInfo = ws;
      this.workspaceRoot = ws.hostRoot;
      this.log(
        "info",
        ws.kind === "wsl" ? `workspace ${ws.hostRoot} (WSL ${ws.wslDistro ?? "?"} ${ws.posixRoot ?? ""})` : `workspace ${ws.hostRoot}`,
      );

      await this.refreshDiagnostics();

      this.activities = [];
      this.stats = {
        connected: false,
        toolCalls: 0,
        failures: 0,
        totalResponseMs: 0,
        activeRequests: 0,
        protocol: this.stats.protocol,
      };
      // Reuse the configured route token, or generate a fresh secret and persist it.
      let token = (cfg.routeToken || "").trim();
      if (!token) {
        token = generateRouteToken();
        settingsStore.updateConfig("routeToken", token);
      }
      this.emitActivity();
      this.emitStats();
      const executor = new ToolExecutor(
        ws.hostRoot,
        (request, cwd, maxMs, opts) => this.agentTerm.run(request, cwd, maxMs, opts),
        {
          onStart: (info) => this.agentTerm.backgroundStarted(info),
          onStdout: (commandId, chunk) => this.agentTerm.backgroundStdout(commandId, chunk),
          onStderr: (commandId, chunk) => this.agentTerm.backgroundStderr(commandId, chunk),
          onExit: (info) => this.agentTerm.backgroundExited(info),
        },
        {
          wslDistro: ws.wslDistro,
          posixRoot: ws.posixRoot,
          defaultShell: ws.defaultShell,
        },
      );
      this.mcp = new McpHttpServer(
        executor,
        { name: "portal", version: "1.0.0" },
        {
          onSessionCreated: () => this.recordSessionConnected(),
          onRequestStart: () => this.recordRequestStart(),
          onRequestEnd: (info) => this.recordRequestEnd(info),
        },
        token,
        cfg.agentInstructions,
      );
      // Bind the MCP server locally; port 0 = OS-assigned free port.
      const port = await this.mcp.start(cfg.localPort || 0);
      this.log("info", t("log.mcpListening", String(port)));

      // Bring up the public tunnel for the configured provider.
      const startedTunnel = await this.startTunnelFor(cfg, port, token);
      this.tunnel = startedTunnel;
      startedTunnel.onUnexpectedExit?.((detail) => this.handleUnexpectedTunnelExit(startedTunnel, detail));
      const publicUrl = startedTunnel.publicUrl;
      const origin = publicUrl.replace(/\/$/, "");
      // Public MCP URL embeds the secret token in the path: <origin>/mcp/<token>.
      const finalUrl = `${origin}/mcp/${encodeURIComponent(token)}`;
      const filesBase = `${origin}/files/${encodeURIComponent(token)}`;
      const maxBytes = cfg.maxTransferBytes;
      executor.setTransferInfo({ filesBaseUrl: filesBase, maxTransferBytes: maxBytes });
      this.mcp.setFileHttp({
        workspaceRoot: ws.hostRoot,
        routeToken: token,
        maxBytes,
        filesBaseUrl: filesBase,
        wslDistro: ws.wslDistro,
        posixRoot: ws.posixRoot,
        onTransfer: (info) =>
          this.recordRequestEnd({
            tool: "file_http",
            ok: info.ok,
            durationMs: 0,
            args: { op: info.op, path: info.path },
            resultText: info.detail ?? (info.bytes != null ? `bytes=${info.bytes}` : ""),
          }),
      });

      this.setState({
        kind: "running",
        since: Date.now(),
        provider: cfg.tunnelProvider,
        publicUrl: finalUrl,
        localPort: port,
        routeToken: token,
        tunnelPid: this.tunnel.pid,
        workspaceRoot: ws.hostRoot,
      });
      this.log("info", t("log.running", finalUrl));
      this.log("info", t("log.fileHttp", filesBase));
      if (cfg.showCommandsInTerminal) {
        this.log("info", t("log.agentReady"));
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const advice = adviceForError(e);
      this.log("error", t("err.startFailed", msg));
      this.logAdvice(advice);
      this.setState({ kind: "error", since: Date.now(), provider: cfg.tunnelProvider, message: msg, advice });
      await this.cleanupTunnelAndServer();
    }
  }

  private logAdvice(advice: ErrorAdvice | undefined): void {
    if (!advice) return;
    this.log("warn", `${advice.code ? `${advice.code}: ` : ""}${advice.title}`);
    this.log("warn", `${t("adv.solutionPrefix")} ${advice.solution}`);
    if (advice.link) this.log("warn", `${t("adv.docsPrefix")} ${advice.link}`);
  }

  async stop(): Promise<void> {
    this.log("info", t("log.stopping"));
    await this.cleanupTunnelAndServer();
    this.setState({ kind: "idle" });
    this.stats = { ...this.stats, connected: false, activeRequests: 0 };
    this.emitStats();
    this.log("info", t("log.stopped"));
  }

  private async startTunnelFor(cfg: PortalConfig, port: number, routeToken: string): Promise<RunningTunnel> {
    const log = (s: string) => this.log("info", s);
    switch (cfg.tunnelProvider) {
      case "ngrok-reserved": {
        if (!cfg.ngrokDomain) throw new Error(t("err.ngrokDomainRequired"));
        const ng = await detectNgrok();
        if (!ng.installed) throw new Error(ng.lastError ?? t("err.ngrokNotInstalled"));
        if (!ng.configValid) throw new Error(ng.lastError ?? t("err.ngrokAuthInvalid"));
        return await startNgrok(port, cfg.ngrokDomain, cfg.ngrokPoolingEnabled, log);
      }
      case "custom": {
        if (!cfg.customTunnelCommand.trim() && !cfg.customTunnelUrl.trim()) {
          throw new Error(t("err.customCommandRequired"));
        }
        return await startCustomTunnel(
          port,
          {
            command: cfg.customTunnelCommand,
            shell: cfg.customTunnelShell,
            url: cfg.customTunnelUrl,
            urlPattern: cfg.customTunnelUrlPattern,
            readyPattern: cfg.customTunnelReadyPattern,
            startupTimeoutMs: cfg.customTunnelTimeoutMs,
            workspaceRoot: this.workspaceRoot ?? undefined,
          },
          routeToken,
          log,
        );
      }
      case "cloudflare-named": {
        if (!cfg.cloudflareDomain) throw new Error(t("err.cfDomainRequired"));
        if (cfg.localPort <= 0) throw new Error(t("err.cfFixedPortRequired"));
        const [cf, tunnelToken] = await Promise.all([detectCloudflared(), getCloudflareToken()]);
        if (!cf.installed) throw new Error(t("err.cfNotInstalled"));
        if (!tunnelToken?.trim()) throw new Error(t("err.cfTokenRequired"));
        return await startCloudflaredNamed(port, cfg.cloudflareDomain, tunnelToken, `/mcp/${encodeURIComponent(routeToken)}`, log);
      }
      case "cloudflare-quick": {
        const cf = await detectCloudflared();
        if (!cf.installed) throw new Error(t("err.cfNotInstalled"));
        return await startCloudflaredQuick(port, log);
      }
    }
  }

  private handleUnexpectedTunnelExit(tunnel: RunningTunnel, detail: string): void {
    // Ignore an old process exiting after another tunnel has already replaced it.
    if (this.tunnel && this.tunnel !== tunnel) return;
    if (this.state.kind !== "running" && this.state.kind !== "starting") return;
    const advice = matchKnownError(detail);
    this.log("error", t("err.tunnelExited", detail));
    this.logAdvice(advice);
    this.tunnel = undefined;
    const mcp = this.mcp;
    this.mcp = undefined;
    mcp?.stop().catch((error: any) => this.log("warn", `mcp.stop: ${error?.message ?? error}`));
    this.stats = { ...this.stats, connected: false, activeRequests: 0 };
    this.emitStats();
    this.setState({ kind: "error", since: Date.now(), provider: tunnel.provider, message: t("err.tunnelExited", detail), advice });
  }

  // Stop the tunnel first, then the HTTP server. Never throws.
  private async cleanupTunnelAndServer(): Promise<void> {
    if (this.tunnel) {
      try {
        await this.tunnel.stop();
      } catch (e: any) {
        this.log("warn", `tunnel.stop: ${e?.message}`);
      }
      this.tunnel = undefined;
    }
    if (this.mcp) {
      try {
        await this.mcp.stop();
      } catch (e: any) {
        this.log("warn", `mcp.stop: ${e?.message}`);
      }
      this.mcp = undefined;
    }
  }

  private setState(s: BridgeState): void {
    this.state = s;
    for (const fn of this.stateListeners) {
      try {
        fn(s);
      } catch {
        /* ignore */
      }
    }
  }

  private log(level: LogEntry["level"], message: string): void {
    this.logger.log(level, message);
    const entry: LogEntry = { ts: Date.now(), level, message };
    for (const fn of this.logListeners) {
      try {
        fn(entry);
      } catch {
        /* ignore */
      }
    }
  }

  private recordSessionConnected(): void {
    this.stats = { ...this.stats, connected: true };
    this.emitStats();
  }

  private recordRequestStart(): void {
    this.stats = { ...this.stats, activeRequests: this.stats.activeRequests + 1 };
    this.emitStats();
  }

  // Every finished tool call becomes one ActivityItem and bumps session stats.
  private recordRequestEnd(info: { tool: string; ok: boolean; durationMs: number; args: any; resultText: string }): void {
    const desc = this.describeTool(info.tool, info.args, info.ok, info.resultText);
    const item: ActivityItem = {
      id: `act-${++this.activitySeq}`,
      ts: Date.now(),
      tool: info.tool,
      title: desc.title,
      detail: desc.detail,
      durationMs: info.durationMs,
      ok: info.ok,
    };
    this.activities.push(item);
    if (this.activities.length > 200) this.activities.splice(0, this.activities.length - 200);
    this.stats = {
      connected: this.stats.connected,
      toolCalls: this.stats.toolCalls + 1,
      failures: this.stats.failures + (info.ok ? 0 : 1),
      totalResponseMs: this.stats.totalResponseMs + info.durationMs,
      lastTool: info.tool,
      lastToolAt: item.ts,
      activeRequests: Math.max(0, this.stats.activeRequests - 1),
      protocol: this.stats.protocol,
    };
    this.emitActivity();
    this.emitStats();
  }

  private describeTool(tool: string, args: any, ok: boolean, resultText: string): { title: string; detail: string } {
    const short = (s: any, n = 56) => {
      const x = String(s ?? "");
      return x.length > n ? x.slice(0, n) + "\u2026" : x;
    };
    switch (tool) {
      case "run_command":
        return { title: short(args?.command ?? args?.executable ?? "", 56), detail: ok ? t("activity.exit0") : t("activity.failed") };
      case "start_command":
        return { title: t("activity.started", short(args?.command ?? args?.executable ?? "", 40)), detail: ok ? t("activity.ok") : t("activity.failed") };
      case "read_command":
        return { title: t("activity.polled", short(args?.command_id ?? "", 16)), detail: ok ? t("activity.ok") : t("activity.failed") };
      case "stop_command":
        return { title: t("activity.stoppedCmd", short(args?.command_id ?? "", 16)), detail: ok ? t("activity.ok") : t("activity.failed") };
      case "file_transfer_info":
        return { title: t("activity.transferInfo"), detail: ok ? t("activity.ok") : t("activity.failed") };
      case "file_http":
        return {
          title: `${String(args?.op ?? "HTTP")} ${short(args?.path ?? "", 40)}`,
          detail: ok ? resultText || t("activity.ok") : t("activity.failed"),
        };
      default:
        return { title: short(tool, 56), detail: ok ? t("activity.ok") : t("activity.failed") };
    }
  }

  private emitActivity(): void {
    for (const fn of this.activityListeners) {
      try {
        fn(this.activities);
      } catch {
        /* ignore */
      }
    }
  }
  private emitStats(): void {
    for (const fn of this.statsListeners) {
      try {
        fn(this.stats);
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    this.cleanupTunnelAndServer().catch(() => {});
    this.agentTerm.dispose();
    this.stateListeners.clear();
    this.logListeners.clear();
    this.diagListeners.clear();
    this.activityListeners.clear();
    this.statsListeners.clear();
  }
}
