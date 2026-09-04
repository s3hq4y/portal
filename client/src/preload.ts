/**
 * Preload — exposes a minimal, typed API to the renderer via contextBridge.
 * contextIsolation stays on; the renderer never touches Node directly.
 */
import { contextBridge, ipcRenderer } from "electron";
import { CH, type PortalApi } from "./shared/ipc";

const invoke = (channel: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(channel, ...args);

const api: PortalApi = {
  getState: () => invoke(CH.GetState),
  start: () => invoke(CH.Start),
  stop: () => invoke(CH.Stop),
  getConfig: () => invoke(CH.GetConfig),
  setConfig: (key, value) => invoke(CH.SetConfig, key, value),
  getDiag: () => invoke(CH.GetDiag),
  refreshDiag: () => invoke(CH.RefreshDiag),
  getLogs: () => invoke(CH.GetLogs),
  clearLogs: () => invoke(CH.ClearLogs),
  getTools: () => invoke(CH.GetTools),
  getActivities: () => invoke(CH.GetActivities),
  getStats: () => invoke(CH.GetStats),
  getPrompts: () => invoke(CH.GetPrompts),
  addPrompt: (p) => invoke(CH.AddPrompt, p),
  updatePrompt: (index, p) => invoke(CH.UpdatePrompt, index, p),
  deletePrompt: (index) => invoke(CH.DeletePrompt, index),
  copyText: (text) => invoke(CH.CopyText, text),
  copyUrl: () => invoke(CH.CopyUrl),
  openExternal: (url) => invoke(CH.OpenExternal, url),
  openLogFolder: () => invoke(CH.OpenLogFolder),
  chooseWorkspace: () => invoke(CH.ChooseWorkspace),
  saveCloudflareToken: (token) => invoke(CH.SaveCloudflareToken, token),
  clearCloudflareToken: () => invoke(CH.ClearCloudflareToken),
  resetRouteToken: () => invoke(CH.ResetRouteToken),
  installNgrok: () => invoke(CH.InstallNgrok),
  installCloudflared: () => invoke(CH.InstallCloudflared),
  getAppInfo: () => invoke(CH.GetAppInfo),
  getStrings: () => invoke(CH.GetStrings),

  browserList: () => invoke(CH.BrowserList),
  browserAttach: (hwnd) => invoke(CH.BrowserAttach, hwnd),
  browserDetach: (hwnd) => invoke(CH.BrowserDetach, hwnd),
  browserAttached: () => invoke(CH.BrowserAttached),
  browserGrab: () => invoke(CH.BrowserGrab),
  browserGrabPoint: (x, y) => invoke(CH.BrowserGrabPoint, x, y),
  browserCancelGrab: () => invoke(CH.BrowserCancelGrab),
  browserOpenEmbedded: (url) => invoke(CH.BrowserOpenEmbedded, url),
  browserCloseEmbedded: () => invoke(CH.BrowserCloseEmbedded),
  browserNavigate: (url) => invoke(CH.BrowserNavigate, url),
  browserControl: (action) => invoke(CH.BrowserControl, action),
  browserEmbedBounds: (rect) => invoke(CH.BrowserEmbedBounds, rect),
  browserDockDragStart: (x, y) => invoke(CH.BrowserDockDragStart, x, y),
  browserDockDragMove: (x, y) => invoke(CH.BrowserDockDragMove, x, y),
  browserDockDragEnd: () => invoke(CH.BrowserDockDragEnd),
  browserDockUndock: () => invoke(CH.BrowserDockUndock),
  browserCdpStatus: () => invoke(CH.BrowserCdpStatus),
  browserCdpConnect: (port, title) => invoke(CH.BrowserCdpConnect, port, title),
  browserCdpDisconnect: () => invoke(CH.BrowserCdpDisconnect),
  browserCdpSetPort: (port) => invoke(CH.BrowserCdpSetPort, port),

  winMinimize: () => invoke(CH.WinMinimize),
  winMaximize: () => invoke(CH.WinMaximize),
  winClose: () => invoke(CH.WinClose),
  winIsMaximized: () => invoke(CH.WinIsMaximized),

  on(channel, cb) {
    const listener = (_event: Electron.IpcRendererEvent, payload: any) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("api", api);

// Convenience globals used by the grab-mode overlay page.
contextBridge.exposeInMainWorld("__grabPoint", (x: number, y: number) => invoke(CH.BrowserGrabPoint, x, y));
contextBridge.exposeInMainWorld("__grabCancel", () => invoke(CH.BrowserCancelGrab));

// Convenience globals used by the dock-host handle bar page (drag-to-undock).
contextBridge.exposeInMainWorld("__dockDragStart", (x: number, y: number) => invoke(CH.BrowserDockDragStart, x, y));
contextBridge.exposeInMainWorld("__dockDragMove", (x: number, y: number) => invoke(CH.BrowserDockDragMove, x, y));
contextBridge.exposeInMainWorld("__dockDragEnd", () => invoke(CH.BrowserDockDragEnd));
contextBridge.exposeInMainWorld("__dockUndock", () => invoke(CH.BrowserDockUndock));
