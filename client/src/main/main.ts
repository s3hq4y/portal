/**
 * Portal Client — Electron main process.
 *
 * A VS Code-free port of the Portal extension: exposes a chosen folder as a
 * public MCP endpoint over a tunnel, with a Fluent UI and native browser
 * window docking. Windows-first (window capture is Win32-only).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, Tray, nativeImage, nativeTheme } from "electron";
import { existsSync } from "node:fs";
import { release } from "node:os";
import * as path from "node:path";
import { CH, type ConfigSnapshot, type TerminalLine, type Toast } from "../shared/ipc";
import { tableFor } from "../shared/l10n";
import { settingsStore, writePromptTemplates } from "./settings-store";
import { clearCloudflareToken, getCloudflareToken, setCloudflareToken } from "./secrets";
import { getLanguage, setLanguage, t } from "./i18n";
import { Logger } from "./logger";
import { BridgeManager } from "./bridge-manager";
import { generateRouteToken } from "./mcp-server";
import { installCloudflaredViaWinget, installNgrokViaWinget } from "./tunnel";
import { CaptureManager } from "./browser/capture-manager";
import { EmbedManager } from "./browser/embed-manager";

const isWindows = process.platform === "win32";
const isWin11 = isWindows && /windows nt 10\.0\.(2[2-9]\d\d|[3-9]\d{3,})/i.test(release());

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
/** Last browser-view rectangle reported by the renderer, in content (DIP) coords. */
let lastBrowserRect: { x: number; y: number; width: number; height: number } | null = null;

const logger = new Logger();
const bridge = new BridgeManager(logger);
let capture: CaptureManager | null = null;
let embed: EmbedManager | null = null;

const PRELOAD = path.join(__dirname, "../preload.js");
const RENDERER = path.join(__dirname, "../renderer/index.html");
const ICON = path.join(__dirname, "../../resources/icon.png");

// ---- helpers ---------------------------------------------------------------

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function toast(message: string, kind: Toast["kind"] = "info"): void {
  send(CH.EvToast, { kind, message } as Toast);
}

async function configSnapshot(): Promise<ConfigSnapshot> {
  const cfg = settingsStore.readConfig();
  const tokenSet = Boolean((await getCloudflareToken())?.trim());
  return { ...cfg, cloudflareTunnelTokenSet: tokenSet };
}

async function pushConfig(): Promise<void> {
  send(CH.EvConfig, { config: await configSnapshot() });
}

function resolveEffectiveLanguage(): "en" | "zh" {
  return settingsStore.resolveLanguage();
}

/**
 * Route the browser view area between the two embedding backends and keep
 * everything clamped inside the main window:
 *  - when a native window is docked, the dock host owns the area (and the
 *    embedded Chromium view is hidden);
 *  - otherwise the embedded Chromium view owns the area (if it is open);
 *  - no bounds → both hidden. Nothing may exceed the window's content area.
 */
function applyBrowserLayout(): void {
  const cb = mainWindow?.getContentBounds();
  const nativeActive = (capture?.listAttached().length ?? 0) > 0;

  if (!lastBrowserRect || !cb) {
    capture?.setBounds(null);
    embed?.setBounds(null);
    return;
  }
  const r = lastBrowserRect;
  // Clamp to the content area so the views can never spill outside the window.
  const cw = Math.max(0, Math.min(r.width, cb.width - r.x));
  const ch = Math.max(0, Math.min(r.height, cb.height - r.y));
  const clamped = { x: r.x, y: r.y, width: cw, height: ch };

  if (nativeActive) {
    embed?.setBounds(null);
    const screenRect = { x: cb.x + clamped.x, y: cb.y + clamped.y, width: clamped.width, height: clamped.height };
    capture?.setBounds(screenRect);
  } else {
    capture?.setBounds(null);
    embed?.setBounds(clamped);
  }
}

// ---- window ----------------------------------------------------------------

function chromeColors(): { overlay: string; symbol: string; bg: string } {
  const dark = nativeTheme.shouldUseDarkColors;
  return dark
    ? { overlay: "#202020", symbol: "#e8e8e8", bg: "#202020" }
    : { overlay: "#f3f3f3", symbol: "#1b1b1b", bg: "#f3f3f3" };
}

function createWindow(): BrowserWindow {
  const c = chromeColors();
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    ...(isWindows ? { titleBarOverlay: { color: c.overlay, symbolColor: c.symbol, height: 48 } } : {}),
    backgroundColor: c.bg,
    icon: existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if (isWin11) {
    try {
      (win as any).setBackgroundMaterial("mica");
    } catch {
      /* Win10 / unsupported */
    }
  }

  void win.loadFile(RENDERER);
  win.once("ready-to-show", () => win.show());

  win.on("close", (e) => {
    if (!quitting) {
      // Minimize-to-tray behaviour: hide instead of quitting.
      e.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  return win;
}

function showMainWindow(): void {
  if (!mainWindow) {
    mainWindow = createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function refreshTitleOverlayTheme(): void {
  if (!mainWindow || !isWindows) return;
  const c = chromeColors();
  mainWindow.setTitleBarOverlay?.({ color: c.overlay, symbolColor: c.symbol, height: 48 });
  mainWindow.setBackgroundColor?.(c.bg);
}

// ---- tray ------------------------------------------------------------------

function createTray(): void {
  if (!existsSync(ICON)) return;
  try {
    const img = nativeImage.createFromPath(ICON);
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip("Portal Client");
    const buildMenu = () =>
      Menu.buildFromTemplate([
        { label: "Open Portal Client", click: () => showMainWindow() },
        { type: "separator" },
        {
          label: bridge.getState().kind === "running" ? "Stop Portal" : "Start Portal",
          click: () => {
            if (bridge.getState().kind === "running") void bridge.stop();
            else void bridge.start();
          },
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]);
    tray.setContextMenu(buildMenu());
    bridge.onState(() => tray?.setContextMenu(buildMenu()));
    tray.on("click", () => showMainWindow());
  } catch (e) {
    console.warn("Tray unavailable:", e);
  }
}

// ---- wiring ----------------------------------------------------------------

function wireBridgeEvents(): void {
  bridge.onState((s) => send(CH.EvState, { state: s }));
  bridge.onDiagnostics((d) => send(CH.EvDiag, { diag: d }));
  bridge.onActivity((items) => send(CH.EvActivity, { items }));
  bridge.onStats((stats) => send(CH.EvStats, { stats }));
  bridge.onTerminalLine((line) => send(CH.EvTerminalLine, { line } as { line: TerminalLine }));
  logger.onLog((entry) => send(CH.EvLog, { entry }));
  logger.onClear(() => send(CH.EvLog, { cleared: true }));
  settingsStore.onChange(() => {
    void pushConfig();
  });
}

function registerIpc(): void {
  ipcMain.handle(CH.GetState, () => bridge.getState());
  ipcMain.handle(CH.Start, async () => {
    await bridge.start();
    return bridge.getState();
  });
  ipcMain.handle(CH.Stop, async () => {
    await bridge.stop();
    return bridge.getState();
  });
  ipcMain.handle(CH.GetConfig, () => configSnapshot());
  ipcMain.handle(CH.SetConfig, async (_e, key: string, value: unknown) => {
    const cfg = settingsStore.updateConfig(key as any, value);
    if (key === "language") {
      setLanguage(settingsStore.resolveLanguage());
      send(CH.EvState, { state: bridge.getState() });
      send(CH.EvDiag, { diag: bridge.getDiagnostics() });
    }
    void cfg;
    return configSnapshot();
  });
  ipcMain.handle(CH.GetDiag, () => bridge.getDiagnostics());
  ipcMain.handle(CH.RefreshDiag, () => bridge.refreshDiagnostics());
  ipcMain.handle(CH.GetLogs, () => logger.getLogs());
  ipcMain.handle(CH.ClearLogs, () => logger.clear());
  ipcMain.handle(CH.GetTools, () => bridge.getExposedTools());
  ipcMain.handle(CH.GetActivities, () => bridge.getActivities());
  ipcMain.handle(CH.GetStats, () => bridge.getStats());
  ipcMain.handle(CH.GetPrompts, () => bridge.getPromptSnapshot());
  ipcMain.handle(CH.AddPrompt, (_e, p) => {
    const cfg = settingsStore.readConfig();
    writePromptTemplates([...cfg.promptTemplates, sanitizePrompt(p)]);
    toast(t("msg.promptSaved"), "success");
    return bridge.getPromptSnapshot();
  });
  ipcMain.handle(CH.UpdatePrompt, (_e, index: number, p) => {
    const cfg = settingsStore.readConfig();
    if (!Number.isInteger(index) || index < 0 || index >= cfg.promptTemplates.length) return bridge.getPromptSnapshot();
    const next = cfg.promptTemplates.slice();
    next[index] = sanitizePrompt(p);
    writePromptTemplates(next);
    toast(t("msg.promptSaved"), "success");
    return bridge.getPromptSnapshot();
  });
  ipcMain.handle(CH.DeletePrompt, (_e, index: number) => {
    const cfg = settingsStore.readConfig();
    if (!Number.isInteger(index) || index < 0 || index >= cfg.promptTemplates.length) return bridge.getPromptSnapshot();
    const next = cfg.promptTemplates.slice();
    const [removed] = next.splice(index, 1);
    writePromptTemplates(next);
    toast(t("msg.promptDeleted", removed?.name ?? ""), "success");
    return bridge.getPromptSnapshot();
  });
  ipcMain.handle(CH.CopyText, (_e, text: string) => clipboard.writeText(String(text ?? "")));
  ipcMain.handle(CH.CopyUrl, async () => {
    const s = bridge.getState();
    if (s.kind === "running") {
      clipboard.writeText(s.publicUrl);
      toast(t("msg.urlCopied"), "success");
    } else {
      toast(t("msg.startFirst"), "warn");
    }
  });
  ipcMain.handle(CH.OpenExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle(CH.OpenLogFolder, async () => {
    const cfg = settingsStore.readConfig();
    const logs = path.join(cfg.workspaceRoot || app.getPath("userData"), ".portal", "logs");
    if (existsSync(logs)) void shell.openPath(logs);
    else void shell.openPath(cfg.workspaceRoot || app.getPath("userData"));
  });
  ipcMain.handle(CH.ChooseWorkspace, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose a folder to expose",
      properties: ["openDirectory"],
    });
    if (!res.canceled && res.filePaths[0]) {
      settingsStore.updateConfig("workspaceRoot", res.filePaths[0]);
      toast(t("msg.workspaceChosen", res.filePaths[0]), "success");
    }
    return configSnapshot();
  });
  ipcMain.handle(CH.SaveCloudflareToken, async (_e, token: string) => {
    const value = String(token ?? "").trim();
    if (!value) {
      toast(t("msg.cfTokenEmpty"), "warn");
      return configSnapshot();
    }
    await setCloudflareToken(value);
    toast(t("msg.cfTokenSaved"), "success");
    void bridge.refreshDiagnostics();
    return configSnapshot();
  });
  ipcMain.handle(CH.ClearCloudflareToken, async () => {
    await clearCloudflareToken();
    toast(t("msg.cfTokenCleared"), "success");
    void bridge.refreshDiagnostics();
    return configSnapshot();
  });
  ipcMain.handle(CH.ResetRouteToken, async () => {
    settingsStore.updateConfig("routeToken", generateRouteToken());
    const st = bridge.getState();
    if (st.kind === "running" || st.kind === "starting") {
      await bridge.stop();
      await bridge.start();
    }
    toast(t("msg.tokenReset"), "success");
    return configSnapshot();
  });
  ipcMain.handle(CH.InstallNgrok, async () => {
    try {
      await installNgrokViaWinget();
      toast(t("msg.ngrokInstalled"), "success");
    } catch (e: any) {
      toast(t("msg.installFailed", e?.message ?? e), "error");
    }
    return bridge.refreshDiagnostics();
  });
  ipcMain.handle(CH.InstallCloudflared, async () => {
    try {
      await installCloudflaredViaWinget();
      toast(t("msg.cfInstalled"), "success");
    } catch (e: any) {
      toast(t("msg.installFailed", e?.message ?? e), "error");
    }
    return bridge.refreshDiagnostics();
  });
  ipcMain.handle(CH.GetAppInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    isWindows,
    isWin11,
    language: getLanguage(),
    userData: app.getPath("userData"),
  }));
  ipcMain.handle(CH.GetStrings, () => ({
    lang: getLanguage(),
    strings: tableFor(getLanguage()),
  }));

  // browser
  ipcMain.handle(CH.BrowserList, () => capture?.list() ?? []);
  ipcMain.handle(CH.BrowserAttach, (_e, hwnd: number) => {
    capture?.attach(Number(hwnd));
  });
  ipcMain.handle(CH.BrowserDetach, (_e, hwnd: number) => {
    capture?.detach(Number(hwnd));
  });
  ipcMain.handle(CH.BrowserAttached, () => capture?.listAttached() ?? []);
  ipcMain.handle(CH.BrowserGrab, () => capture?.startGrab());
  ipcMain.handle(CH.BrowserGrabPoint, (_e, x: number, y: number) => capture?.grabAt(Number(x), Number(y)));
  ipcMain.handle(CH.BrowserCancelGrab, () => capture?.cancelGrab());
  ipcMain.handle(CH.BrowserOpenEmbedded, (_e, url?: string) => {
    embed?.open(url);
    applyBrowserLayout();
  });
  ipcMain.handle(CH.BrowserCloseEmbedded, () => {
    embed?.close();
    applyBrowserLayout();
  });
  ipcMain.handle(CH.BrowserNavigate, (_e, url: string) => embed?.navigate(String(url ?? "")));
  ipcMain.handle(CH.BrowserControl, (_e, action: "back" | "forward" | "reload" | "stop") => embed?.control(action));
  ipcMain.handle(CH.BrowserEmbedBounds, (_e, rect: { x: number; y: number; width: number; height: number } | null) => {
    const r = rect && Number.isFinite(rect.x) && rect.width > 0 && rect.height > 0 ? rect : null;
    lastBrowserRect = r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    applyBrowserLayout();
  });
  ipcMain.handle(CH.BrowserDockDragStart, (_e, x: number, y: number) => capture?.beginDockDrag(Number(x), Number(y)));
  ipcMain.handle(CH.BrowserDockDragMove, (_e, x: number, y: number) => capture?.moveDockDrag(Number(x), Number(y)));
  ipcMain.handle(CH.BrowserDockDragEnd, () => capture?.endDockDrag());
  ipcMain.handle(CH.BrowserDockUndock, () => capture?.undockFromHandle());

  // window chrome
  ipcMain.handle(CH.WinMinimize, () => mainWindow?.minimize());
  ipcMain.handle(CH.WinMaximize, () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle(CH.WinClose, () => mainWindow?.close());
  ipcMain.handle(CH.WinIsMaximized, () => mainWindow?.isMaximized() ?? false);
}

function sanitizePrompt(p: any): { name: string; text: string } {
  const name = String(p?.name ?? "").trim().slice(0, 60);
  const text = String(p?.text ?? "").trim().slice(0, 4000);
  return { name: name || text.replace(/\s+/g, " ").slice(0, 24), text };
}

// ---- lifecycle -------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  app.whenReady().then(() => {
    app.setAppUserModelId("dev.portal.client");
    setLanguage(resolveEffectiveLanguage());

    mainWindow = createWindow();
    capture = new CaptureManager(
      mainWindow,
      PRELOAD,
      (attached) => {
        send(CH.EvBrowserAttached, { attached });
        applyBrowserLayout();
      },
      toast,
    );
    embed = new EmbedManager(mainWindow);
    embed.onNavigationState((info) => send(CH.EvBrowserEmbedState, { info }));

    wireBridgeEvents();
    registerIpc();
    createTray();
    refreshTitleOverlayTheme();

    // Auto-start on launch if configured and a folder is set.
    const cfg = settingsStore.readConfig();
    if (cfg.startOnActivation && cfg.workspaceRoot) {
      setTimeout(() => {
        bridge.start().catch((e: any) => logger.log("error", `auto-start: ${e?.message ?? e}`));
      }, 500);
    }
    // Initial diagnostics probe.
    bridge.refreshDiagnostics().catch(() => {});

    nativeTheme.on("updated", () => {
      refreshTitleOverlayTheme();
    });
  });

  app.on("activate", () => showMainWindow());

  app.on("before-quit", () => {
    quitting = true;
    bridge.dispose();
    capture?.dispose();
    embed?.dispose();
  });

  app.on("window-all-closed", () => {
    // Keep running in the tray on Windows; quit elsewhere.
    if (!isWindows) app.quit();
  });
}
