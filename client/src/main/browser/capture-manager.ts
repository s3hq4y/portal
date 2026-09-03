/**
 * CaptureManager — docks a real browser window (Edge / Chrome / Firefox) into
 * the app via Win32 SetParent, and undocks it again. The dock host is a slim
 * frameless window whose content is a "handle bar": the native browser window
 * is parented below it, and the handle can be dragged to tear the window out
 * (or clicked to undock). Also implements "grab mode": a translucent overlay
 * that captures the next click on a browser window.
 *
 * Windows-only. Every operation is defensive: failures are logged and never
 * crash the app. On dispose, any docked window is returned to the desktop.
 */
import { BrowserWindow, screen } from "electron";
import type { BrowserWindowInfo } from "../../shared/types";
import {
  getWindowRect,
  isWindow,
  listBrowserWindows,
  positionWindow,
  positionWindowTop,
  restoreWindow,
  setParent,
  showWindow,
  windowFromPoint,
  win32Available,
  type WinRect,
} from "./win32";

const SW_SHOW = 5;
const SW_RESTORE = 9;
/** Handle bar height in DIPs (CSS pixels). */
const HANDLE_H = 32;

interface Attached {
  hwnd: number;
  title: string;
  processName: string;
  pid: number;
  /** Normal window rect recorded before docking (physical pixels). */
  prevRect: WinRect | null;
}

interface TearDrag {
  hwnd: number;
  dx: number;
  dy: number;
  w: number;
  h: number;
  lastX: number;
  lastY: number;
  prevRect: WinRect | null;
}

export class CaptureManager {
  private dockHost: BrowserWindow | null = null;
  private overlay: BrowserWindow | null = null;
  private attached = new Map<number, Attached>();
  private bounds: { x: number; y: number; width: number; height: number } | null = null;
  private grabbing = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private tear: TearDrag | null = null;
  private dockTitle = "";

  constructor(
    private readonly mainWindow: BrowserWindow,
    private readonly preloadPath: string,
    private readonly onAttachedChanged: (attached: BrowserWindowInfo[]) => void,
    private readonly toast: (message: string, kind?: "info" | "success" | "warn" | "error") => void,
  ) {}

  available(): boolean {
    return win32Available();
  }

  /** Enumerate browser windows; mark which are currently docked. */
  list(): BrowserWindowInfo[] {
    if (!win32Available()) return [];
    return listBrowserWindows().map((w) => ({
      hwnd: w.hwnd,
      pid: w.pid,
      processName: w.processName,
      title: w.title,
      attached: false,
      embedded: this.attached.has(w.hwnd),
    }));
  }

  listAttached(): BrowserWindowInfo[] {
    return [...this.attached.values()].map((a) => ({
      hwnd: a.hwnd,
      pid: a.pid,
      processName: a.processName,
      title: a.title,
      attached: true,
      embedded: true,
    }));
  }

  attach(hwnd: number): void {
    if (!win32Available() || this.attached.has(hwnd)) return;
    if (!isWindow(hwnd)) {
      this.toast("The selected window is no longer available.", "warn");
      return;
    }
    try {
      // Single-window docking: send the previously docked window back first.
      const previous = this.attached.keys().next().value as number | undefined;
      if (previous !== undefined && previous !== hwnd) this.detach(previous, true);

      // Record the window's identity + normal rectangle BEFORE re-parenting
      // (once parented it becomes a WS_CHILD window and the enumerator would
      // filter it out).
      const info = listBrowserWindows().find((w) => w.hwnd === hwnd);
      showWindow(hwnd, SW_RESTORE);
      const prevRect = getWindowRect(hwnd);

      const host = this.ensureDockHost();
      const hostHwnd = this.readHwnd(host);
      if (!hostHwnd) return;
      const parent = setParent(hwnd, hostHwnd);
      // If SetParent failed it returns 0 and the window stays on the desktop.
      if (!parent) {
        this.toast("Could not attach this window (SetParent failed).", "error");
        return;
      }
      this.attached.set(hwnd, {
        hwnd,
        title: info?.title ?? "",
        processName: info?.processName ?? "",
        pid: info?.pid ?? 0,
        prevRect,
      });
      this.dockTitle = info?.title ?? "";
      showWindow(hwnd, SW_SHOW);
      this.fitChildrenToHost();
      this.showHost();
      this.pushDockTitle();
      this.ensurePolling();
      this.emit();
      this.toast(`Docked: ${this.dockTitle || "browser window"}`, "success");
    } catch (e: any) {
      this.toast(`Attach failed: ${e?.message ?? e}`, "error");
    }
  }

  detach(hwnd: number, silent = false): void {
    if (!win32Available()) return;
    const a = this.attached.get(hwnd);
    if (!a) return;
    try {
      setParent(hwnd, 0);
      if (a.prevRect && a.prevRect.right > a.prevRect.left && a.prevRect.bottom > a.prevRect.top) {
        positionWindowTop(hwnd, a.prevRect.left, a.prevRect.top, a.prevRect.right - a.prevRect.left, a.prevRect.bottom - a.prevRect.top);
      }
      restoreWindow(hwnd);
    } catch (e: any) {
      this.toast(`Detach failed: ${e?.message ?? e}`, "error");
    }
    this.attached.delete(hwnd);
    this.afterDetach(silent);
  }

  detachAll(): void {
    for (const hwnd of [...this.attached.keys()]) {
      try {
        setParent(hwnd, 0);
        restoreWindow(hwnd);
      } catch {
        /* ignore */
      }
    }
    this.attached.clear();
    this.destroyHost();
    this.emit();
  }

  /** Position the dock host (and its children) over a screen-space rectangle. */
  setBounds(rect: { x: number; y: number; width: number; height: number } | null): void {
    // Never move or hide the host while a tear-off drag is in flight — the
    // handle bar must keep receiving captured pointer events.
    if (this.tear) return;
    this.bounds = rect;
    if (!this.dockHost) return;
    if (!rect || rect.width <= 0 || rect.height <= 0 || this.attached.size === 0) {
      this.hideHost();
      return;
    }
    this.dockHost.setBounds(rect, false);
    this.fitChildrenToHost();
    this.showHost();
  }

  // ---- grab mode ----------------------------------------------------------

  startGrab(): void {
    if (!win32Available()) {
      this.toast("Window capture is only available on Windows.", "warn");
      return;
    }
    if (this.grabbing) return;
    this.grabbing = true;
    const display = screen.getPrimaryDisplay();
    const b = display.bounds;
    this.overlay = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      fullscreenable: false,
      webPreferences: { preload: this.preloadPath, contextIsolation: true, nodeIntegration: false },
    });
    const html = grabOverlayHtml(b.x, b.y);
    void this.overlay.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    this.overlay.once("closed", () => {
      this.overlay = null;
    });
  }

  /** Called by the overlay renderer with the click point (screen coords). */
  async grabAt(x: number, y: number): Promise<void> {
    if (!this.grabbing) return;
    this.grabbing = false;
    const ov = this.overlay;
    if (ov && !ov.isDestroyed()) ov.hide();
    // Give the OS a beat to reveal the window beneath the overlay.
    await new Promise((r) => setTimeout(r, 80));
    // The overlay reports DIPs; WindowFromPoint wants physical pixels.
    const pt = this.dipPointToPixel(x, y);
    const hwnd = windowFromPoint(pt);
    try {
      ov?.close();
    } catch {
      /* ignore */
    }
    if (!hwnd) {
      this.toast("No window found at that point.", "warn");
      return;
    }
    const match = listBrowserWindows().find((w) => w.hwnd === hwnd);
    if (!match) {
      this.toast("That window is not a supported browser (Edge / Chrome / Firefox).", "warn");
      return;
    }
    this.attach(hwnd);
  }

  cancelGrab(): void {
    if (!this.grabbing && !this.overlay) return;
    this.grabbing = false;
    try {
      this.overlay?.close();
    } catch {
      /* ignore */
    }
    this.overlay = null;
  }

  isGrabbing(): boolean {
    return this.grabbing;
  }

  // ---- tear-off drag (driven by the dock host handle bar) -----------------

  beginDockDrag(xDip: number, yDip: number): void {
    const hwnd = this.singleAttachedHwnd();
    if (hwnd === 0) return;
    const a = this.attached.get(hwnd);
    if (!a) return;
    const rect = getWindowRect(hwnd);
    if (!rect || rect.right <= rect.left || rect.bottom <= rect.top) return;
    const pt = this.dipPointToPixel(xDip, yDip);
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    // Lift off immediately: detach so the window can follow the cursor.
    setParent(hwnd, 0);
    this.attached.delete(hwnd);
    this.tear = {
      hwnd,
      dx: pt.x - rect.left,
      dy: pt.y - rect.top,
      w,
      h,
      lastX: rect.left,
      lastY: rect.top,
      prevRect: a.prevRect,
    };
    positionWindowTop(hwnd, rect.left, rect.top, w, h);
    showWindow(hwnd, SW_SHOW);
    // Deliberately no emit() here: emitting would re-run the browser layout and
    // hide/destroy the dock host while the handle bar is still capturing the
    // pointer for the drag. The renderer is notified on drag end instead.
  }

  moveDockDrag(xDip: number, yDip: number): void {
    if (!this.tear) return;
    const pt = this.dipPointToPixel(xDip, yDip);
    this.tear.lastX = pt.x - this.tear.dx;
    this.tear.lastY = pt.y - this.tear.dy;
    positionWindowTop(this.tear.hwnd, this.tear.lastX, this.tear.lastY, this.tear.w, this.tear.h);
  }

  endDockDrag(): void {
    if (!this.tear) return;
    const { hwnd, lastX, lastY, w, h, prevRect } = this.tear;
    this.tear = null;
    // Snap to the drop position; restore the window's normal size.
    if (prevRect && prevRect.right > prevRect.left && prevRect.bottom > prevRect.top) {
      positionWindowTop(hwnd, lastX, lastY, prevRect.right - prevRect.left, prevRect.bottom - prevRect.top);
    } else {
      positionWindowTop(hwnd, lastX, lastY, w, h);
    }
    showWindow(hwnd, SW_SHOW);
    this.destroyHost();
    this.emit();
    this.toast("Window returned to the desktop.", "info");
  }

  /** Undock via the handle bar's ✕ button. */
  undockFromHandle(): void {
    const hwnd = this.singleAttachedHwnd();
    if (hwnd === 0) return;
    this.detach(hwnd, true);
    this.toast("Window returned to the desktop.", "info");
  }

  // ---- internals ----------------------------------------------------------

  private singleAttachedHwnd(): number {
    const first = this.attached.keys().next().value as number | undefined;
    return first ?? 0;
  }

  private afterDetach(silent: boolean): void {
    if (this.attached.size === 0) {
      this.destroyHost();
      this.stopPolling();
    }
    this.emit();
    if (!silent) this.toast("Window returned to the desktop.", "info");
  }

  private ensureDockHost(): BrowserWindow {
    if (this.dockHost && !this.dockHost.isDestroyed()) return this.dockHost;
    this.dockHost = new BrowserWindow({
      frame: false,
      show: false,
      parent: this.mainWindow,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      backgroundColor: "#1f1f1f",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    const wc = this.dockHost.webContents;
    wc.on("did-finish-load", () => this.pushDockTitle());
    void this.dockHost.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(dockHandleHtml()));
    this.dockHost.on("closed", () => {
      this.dockHost = null;
    });
    return this.dockHost;
  }

  private pushDockTitle(): void {
    if (!this.dockHost || this.dockHost.isDestroyed()) return;
    this.dockHost.webContents
      .executeJavaScript(
        `var n=document.getElementById('t'); if(n){ n.textContent = ${JSON.stringify(this.dockTitle || "Browser window")}; }`,
      )
      .catch(() => {});
  }

  private readHwnd(win: BrowserWindow): number {
    const buf = win.getNativeWindowHandle();
    // USER handles are 32-bit on Windows even under x64.
    return buf.readUInt32LE(0);
  }

  private showHost(): void {
    try {
      if (!this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) {
        this.dockHost?.hide();
        return;
      }
      this.dockHost?.setBounds(this.bounds, false);
      this.dockHost?.show();
    } catch {
      /* ignore */
    }
  }

  private hideHost(): void {
    try {
      this.dockHost?.hide();
    } catch {
      /* ignore */
    }
  }

  private destroyHost(): void {
    try {
      this.dockHost?.close();
    } catch {
      /* ignore */
    }
    this.dockHost = null;
  }

  private fitChildrenToHost(): void {
    if (!this.dockHost) return;
    const [wDip, hDip] = this.dockHost.getContentSize();
    const s = this.scaleFactor();
    const w = Math.round(wDip * s);
    const h = Math.round(hDip * s);
    const top = Math.round(HANDLE_H * s);
    for (const hwnd of this.attached.keys()) {
      positionWindow(hwnd, 0, top, w, Math.max(0, h - top));
    }
  }

  private scaleFactor(): number {
    try {
      return screen.getDisplayMatching(this.mainWindow.getBounds()).scaleFactor;
    } catch {
      return 1;
    }
  }

  private dipPointToPixel(x: number, y: number): { x: number; y: number } {
    try {
      const s = screen.getDisplayNearestPoint({ x, y }).scaleFactor;
      return { x: Math.round(x * s), y: Math.round(y * s) };
    } catch {
      return { x: Math.round(x), y: Math.round(y) };
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      let changed = false;
      for (const hwnd of [...this.attached.keys()]) {
        if (!isWindow(hwnd)) {
          this.attached.delete(hwnd);
          changed = true;
        }
      }
      if (this.attached.size === 0 && !this.tear) {
        this.destroyHost();
        this.stopPolling();
      }
      if (changed) this.emit();
    }, 1000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private emit(): void {
    this.onAttachedChanged(this.listAttached());
  }

  dispose(): void {
    this.stopPolling();
    this.detachAll();
    try {
      this.overlay?.close();
    } catch {
      /* ignore */
    }
    this.destroyHost();
    this.overlay = null;
  }
}

function dockHandleHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;background:#1f1f1f;
    font-family:"Segoe UI",system-ui,sans-serif;color:#e8e8e8;-webkit-user-select:none;user-select:none;}
  .handle{height:${HANDLE_H}px;display:flex;align-items:center;gap:8px;padding:0 6px 0 10px;
    background:#2b2b2b;border-bottom:1px solid #3a3a3a;cursor:grab;box-sizing:border-box;}
  .handle.grabbing{cursor:grabbing;}
  .dot{width:8px;height:8px;border-radius:50%;background:#0078D4;flex:none;}
  .title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;}
  .hint{font-size:11px;color:#9a9a9a;flex:none;white-space:nowrap;}
  .x{width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;
    cursor:pointer;border:none;background:transparent;color:#c7c7c7;font-size:14px;line-height:1;
    border-radius:4px;font-family:inherit;}
  .x:hover{background:#3d3d3d;color:#fff;}
  </style></head><body>
  <div class="handle" id="h" title="Drag to undock">
    <span class="dot"></span>
    <span class="title" id="t">Browser window</span>
    <span class="hint">drag to undock</span>
    <button class="x" id="x" title="Undock">&#10005;</button>
  </div>
  <script>
    var h=document.getElementById('h'), x=document.getElementById('x');
    x.addEventListener('pointerdown',function(e){e.stopPropagation();});
    x.addEventListener('click',function(){window.__dockUndock&&window.__dockUndock();});
    h.addEventListener('pointerdown',function(e){
      if(e.button!==0)return;
      h.classList.add('grabbing');
      try{h.setPointerCapture(e.pointerId);}catch(_){}
      window.__dockDragStart&&window.__dockDragStart(e.screenX,e.screenY);
    });
    h.addEventListener('pointermove',function(e){
      if(!h.classList.contains('grabbing'))return;
      window.__dockDragMove&&window.__dockDragMove(e.screenX,e.screenY);
    });
    h.addEventListener('pointerup',function(e){
      if(!h.classList.contains('grabbing'))return;
      h.classList.remove('grabbing');
      window.__dockDragEnd&&window.__dockDragEnd();
    });
    h.addEventListener('pointercancel',function(){
      if(!h.classList.contains('grabbing'))return;
      h.classList.remove('grabbing');
      window.__dockDragEnd&&window.__dockDragEnd();
    });
  </script></body></html>`;
}

function grabOverlayHtml(originX: number, originY: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;cursor:crosshair;overflow:hidden;-webkit-user-select:none;user-select:none;}
  .scrim{position:fixed;inset:0;background:rgba(0,0,0,0.18);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;color:#fff;font-family:"Segoe UI",sans-serif;}
  .ring{width:64px;height:64px;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,0.4);}
  .hint{font-size:15px;background:rgba(0,0,0,0.55);padding:8px 16px;border-radius:4px;}
  </style></head><body>
  <div class="scrim"><div class="ring"></div><div class="hint">Click a browser window to dock it — Esc to cancel</div></div>
  <script>
    const dx=${originX}, dy=${originY};
    window.addEventListener("pointerdown", (e) => {
      if (e.button === 2) { window.__grabCancel && window.__grabCancel(); return; }
      window.__grabPoint && window.__grabPoint(dx + e.clientX, dy + e.clientY);
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") window.__grabCancel && window.__grabCancel();
    });
  </script></body></html>`;
}
