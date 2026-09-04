/**
 * SessionHub — manages one BridgeManager per MCP token profile so that
 * several independent MCP endpoints (tokens / workspaces / tunnels) can run
 * in parallel at the same time, while the sidebar can select which session is
 * "active" for display and per-session start/stop.
 *
 * It exposes the same surface the UI needs (state/log/activity/stats events,
 * start/stop, diagnostics, prompt snapshot) but always relays the *active*
 * session. When no token profiles are configured, a single legacy session
 * (bound to the global portal.* settings) is used as the default, keeping the
 * extension fully backward-compatible.
 */
import * as vscode from "vscode";
import { BridgeManager } from "./bridge-manager";
import { selectionTarget } from "./profiles";
import {
  ActivityItem, BridgeState, ErrorAdvice, LogEntry, MCPTokenProfile,
  PromptTemplate, SessionStats, TunnelDiagnostics,
} from "./types";
import { defaultProfileOverride, effectiveConfigFor, readConfig, readTokenProfiles, updateConfig } from "./config";

const DEFAULT_SESSION = "default";

export class SessionHub {
  private managers = new Map<string, BridgeManager>();
  private activeId: string = DEFAULT_SESSION;

  private stateListeners = new Set<(s: BridgeState) => void>();
  private logListeners = new Set<(e: LogEntry) => void>();
  private diagListeners = new Set<(d: TunnelDiagnostics) => void>();
  private activityListeners = new Set<(a: readonly ActivityItem[]) => void>();
  private statsListeners = new Set<(s: SessionStats) => void>();
  private wireDisposables: vscode.Disposable[] = [];

  constructor(private readonly output: vscode.OutputChannel, private readonly secrets: vscode.SecretStorage) {
    // Restore the workspace's last selection (portal.activeTokenId).
    const saved = readConfig().activeTokenId;
    if (saved) this.activeId = saved;
  }

  // ---- session listing / selection ----
  /** All token profiles currently configured (empty => the legacy default session). */
  listSessions(): Array<{ id: string; label: string; routeToken: string; workspace?: string }> {
    const profiles = readTokenProfiles();
    if (!profiles.length) {
      const d = defaultProfileOverride();
      return [{ id: DEFAULT_SESSION, label: d?.label ?? "default", routeToken: d?.routeToken ?? "", workspace: d?.workspacePath }];
    }
    return profiles.map((p) => ({ id: p.id, label: p.label, routeToken: p.routeToken, workspace: p.workspacePath }));
  }

  getActiveId(): string { return this.activeId; }

  setActive(id: string): void {
    if (!this.listSessions().some((s) => s.id === id)) return;
    if (this.activeId === id) return;
    this.activeId = id;
    this.rewire();
    void updateConfig("activeTokenId", id, selectionTarget());
  }

  private profileFor(sid: string): MCPTokenProfile | undefined {
    return readTokenProfiles().find((p) => p.id === sid);
  }

  private sessionId(id?: string): string { return id || this.activeId; }

  /** Get (creating on demand) the BridgeManager for a session id. */
  manager(id?: string): BridgeManager {
    const sid = this.sessionId(id);
    let bm = this.managers.get(sid);
    if (!bm) {
      bm = new BridgeManager(this.output, this.secrets, this.profileFor(sid));
      this.managers.set(sid, bm);
      if (sid === this.activeId && !this.wireDisposables.length) this.rewire();
    }
    return bm;
  }

  // ---- event wiring (relays the ACTIVE session) ----
  private rewire(): void {
    for (const d of this.wireDisposables) d.dispose();
    this.wireDisposables = [];
    const bm = this.managers.get(this.activeId);
    if (!bm) return;
    this.wireDisposables.push(
      bm.onState((s) => { for (const fn of this.stateListeners) try { fn(s); } catch { /* ignore */ } }),
      bm.onLog((e) => { for (const fn of this.logListeners) try { fn(e); } catch { /* ignore */ } }),
      bm.onDiagnostics((d) => { for (const fn of this.diagListeners) try { fn(d); } catch { /* ignore */ } }),
      bm.onActivity((a) => { for (const fn of this.activityListeners) try { fn(a); } catch { /* ignore */ } }),
      bm.onStats((s) => { for (const fn of this.statsListeners) try { fn(s); } catch { /* ignore */ } }),
    );
  }

  onState(fn: (s: BridgeState) => void): vscode.Disposable { this.stateListeners.add(fn); fn(this.manager().getState()); return { dispose: () => this.stateListeners.delete(fn) }; }
  onLog(fn: (e: LogEntry) => void): vscode.Disposable { this.logListeners.add(fn); return { dispose: () => this.logListeners.delete(fn) }; }
  onDiagnostics(fn: (d: TunnelDiagnostics) => void): vscode.Disposable { this.diagListeners.add(fn); const d = this.manager().getDiagnostics(); if (d) fn(d); return { dispose: () => this.diagListeners.delete(fn) }; }
  onActivity(fn: (a: readonly ActivityItem[]) => void): vscode.Disposable { this.activityListeners.add(fn); fn(this.manager().getActivities()); return { dispose: () => this.activityListeners.delete(fn) }; }
  onStats(fn: (s: SessionStats) => void): vscode.Disposable { this.statsListeners.add(fn); fn(this.manager().getStats()); return { dispose: () => this.statsListeners.delete(fn) }; }

  // ---- delegated getters (active session) ----
  getState(): BridgeState { return this.manager().getState(); }
  getDiagnostics(): TunnelDiagnostics | null { return this.manager().getDiagnostics(); }
  getLogs(): readonly LogEntry[] { return this.manager().getLogs(); }
  getActivities(): readonly ActivityItem[] { return this.manager().getActivities(); }
  getStats(): SessionStats { return this.manager().getStats(); }
  getPromptSnapshot(): { templates: PromptTemplate[]; url?: string } { return this.manager().getPromptSnapshot(); }
  getExposedTools() { return this.manager().getExposedTools(); }

  // ---- per-session + parallel orchestration ----
  async start(id?: string): Promise<void> { await this.manager(id).start(); }
  async stop(id?: string): Promise<void> { const sid = this.sessionId(id); const bm = this.managers.get(sid); if (bm) await bm.stop(); }

  async startAll(): Promise<void> {
    const ids = this.listSessions().map((s) => s.id).length ? this.listSessions().map((s) => s.id) : [DEFAULT_SESSION];
    await Promise.all(ids.map((id) => this.manager(id).start().catch((e) => this.output.appendLine(`[hub:start ${id}] ${e?.message ?? e}`))));
  }
  async stopAll(): Promise<void> {
    const ids = Array.from(this.managers.keys());
    await Promise.all(ids.map((id) => this.managers.get(id)!.stop().catch((e) => this.output.appendLine(`[hub:stop ${id}] ${e?.message ?? e}`))));
  }

  /** Restart the active (or a specific) session — e.g. after the connection profile changed. */
  async restart(id?: string): Promise<void> {
    const sid = this.sessionId(id);
    const existing = this.managers.get(sid);
    if (existing) await existing.stop();
    await this.manager(sid).start();
  }

  async refreshDiagnostics(id?: string): Promise<TunnelDiagnostics> { return this.manager(id).refreshDiagnostics(); }
  showAgentTerminal(id?: string): void { this.manager(id).showAgentTerminal(); }

  dispose(): void {
    for (const d of this.wireDisposables) d.dispose();
    for (const bm of this.managers.values()) bm.dispose();
    this.managers.clear();
    this.wireDisposables = [];
  }
}
