/**
 * EmbedManager — the built-in browser: a WebContentsView (Chromium) that the
 * renderer positions over its "embed host" rectangle. Used as a fallback to
 * native window capture, and as a quick way to open links inside the app.
 */
import { BrowserWindow, WebContentsView, shell } from "electron";

const HOME = "https://www.bing.com";

export class EmbedManager {
  private view: WebContentsView | null = null;
  private bounds: { x: number; y: number; width: number; height: number } | null = null;
  private url = HOME;
  private onNavState: ((info: { url: string; canGoBack: boolean; canGoForward: boolean }) => void) | null = null;

  constructor(private readonly mainWindow: BrowserWindow) {}

  isOpen(): boolean {
    return this.view !== null;
  }

  open(url?: string): void {
    if (!this.view) {
      this.view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: "portal-embedded",
        },
      });
      this.mainWindow.contentView.addChildView(this.view);
      const wc = this.view.webContents;
      // Keep the app from navigating away entirely on target=_blank links.
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
          this.navigate(url);
        } else {
          void shell.openExternal(url);
        }
        return { action: "deny" };
      });
      wc.on("did-navigate", () => this.pushNavState());
      wc.on("did-navigate-in-page", () => this.pushNavState());
      wc.on("did-finish-load", () => this.pushNavState());
      wc.on("render-process-gone", () => this.pushNavState());
      this.applyBounds();
    }
    if (url) this.navigate(url);
    else this.view.webContents.loadURL(this.url).catch(() => {});
    this.pushNavState();
  }

  close(): void {
    if (!this.view) return;
    const view = this.view;
    this.view = null;
    this.bounds = null;
    try {
      view.setVisible(false);
    } catch {
      /* ignore */
    }
    try {
      this.mainWindow.contentView.removeChildView(view);
    } catch {
      /* ignore */
    }
    try {
      view.webContents.close();
    } catch {
      /* ignore */
    }
  }

  navigate(url: string): void {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    this.url = target;
    this.view?.webContents.loadURL(target).catch(() => {});
  }

  control(action: "back" | "forward" | "reload" | "stop"): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    switch (action) {
      case "back":
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case "forward":
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case "reload":
        wc.reload();
        break;
      case "stop":
        wc.stop();
        break;
    }
  }

  onNavigationState(fn: (info: { url: string; canGoBack: boolean; canGoForward: boolean }) => void): void {
    this.onNavState = fn;
  }

  /** Position the view over a content-area rectangle (or hide it when null). */
  setBounds(rect: { x: number; y: number; width: number; height: number } | null): void {
    this.bounds = rect;
    this.applyBounds();
  }

  private applyBounds(): void {
    if (!this.view) return;
    if (!this.bounds || this.bounds.width <= 0 || this.bounds.height <= 0) {
      this.view.setVisible(false);
      return;
    }
    const r = this.bounds;
    this.view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    this.view.setVisible(true);
  }

  private pushNavState(): void {
    const wc = this.view?.webContents;
    if (!wc) return;
    this.onNavState?.({
      url: wc.getURL() || this.url,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  }

  dispose(): void {
    this.close();
  }
}
