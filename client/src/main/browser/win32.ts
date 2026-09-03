/**
 * Minimal Win32 bindings via koffi (FFI, no compilation) used by the
 * browser-window capture feature. Windows-only; every function is defensive.
 *
 * Note on handles: USER window handles (HWND) are 32-bit values even on x64,
 * so they are carried as plain JS numbers. Process handles are carried as
 * numbers too (koffi maps intptr_t to a JS number for values below 2^53).
 */
import koffi from "koffi";

export const BROWSER_PROCESSES = new Set([
  "msedge.exe",
  "chrome.exe",
  "firefox.exe",
  "brave.exe",
  "vivaldi.exe",
  "opera.exe",
]);

export const BROWSER_CLASSES = new Set(["Chrome_WidgetWin_1", "Chrome_WidgetWin_0", "MozillaWindowClass"]);

// Window style/exstyle constants
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_EX_TOOLWINDOW = 0x00000080;
const GW_OWNER = 4;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export interface WinRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WinPoint {
  x: number;
  y: number;
}

let loaded = false;
let user32: any;
let kernel32: any;
let EnumWindowsFn: any;
let GetWindowTextLengthWFn: any;
let GetWindowTextWFn: any;
let GetClassNameWFn: any;
let IsWindowVisibleFn: any;
let IsWindowFn: any;
let GetWindowThreadProcessIdFn: any;
let GetWindowLongPtrWFn: any;
let GetWindowFn: any;
let SetParentFn: any;
let ShowWindowFn: any;
let MoveWindowFn: any;
let SetWindowPosFn: any;
let GetWindowRectFn: any;
let GetCursorPosFn: any;
let WindowFromPointFn: any;
let OpenProcessFn: any;
let QueryFullProcessImageNameWFn: any;
let CloseHandleFn: any;
let RECT: any;
let POINT: any;
let EnumProcType: any;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    user32 = koffi.load("user32.dll");
    kernel32 = koffi.load("kernel32.dll");

    RECT = koffi.struct("PortalRECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
    POINT = koffi.struct("PortalPOINT", { x: "int32", y: "int32" });

    const EnumWindowsProc = koffi.proto("PortalEnumWindowsProc", "int32", ["intptr_t", "intptr_t"]);
    EnumProcType = koffi.pointer(EnumWindowsProc);
    EnumWindowsFn = user32.func("EnumWindows", "int32", [EnumProcType, "intptr_t"]);
    GetWindowTextLengthWFn = user32.func("GetWindowTextLengthW", "int32", ["intptr_t"]);
    GetWindowTextWFn = user32.func("GetWindowTextW", "int32", ["intptr_t", "void *", "int32"]);
    GetClassNameWFn = user32.func("GetClassNameW", "int32", ["intptr_t", "void *", "int32"]);
    IsWindowVisibleFn = user32.func("IsWindowVisible", "int32", ["intptr_t"]);
    IsWindowFn = user32.func("IsWindow", "int32", ["intptr_t"]);
    GetWindowThreadProcessIdFn = user32.func("GetWindowThreadProcessId", "uint32", ["intptr_t", koffi.out(koffi.pointer("uint32"))]);
    GetWindowLongPtrWFn = user32.func("GetWindowLongPtrW", "intptr_t", ["intptr_t", "int32"]);
    GetWindowFn = user32.func("GetWindow", "intptr_t", ["intptr_t", "uint32"]);
    SetParentFn = user32.func("SetParent", "intptr_t", ["intptr_t", "intptr_t"]);
    ShowWindowFn = user32.func("ShowWindow", "int32", ["intptr_t", "int32"]);
    MoveWindowFn = user32.func("MoveWindow", "int32", ["intptr_t", "int32", "int32", "int32", "int32", "int32"]);
    SetWindowPosFn = user32.func("SetWindowPos", "int32", ["intptr_t", "intptr_t", "int32", "int32", "int32", "int32", "uint32"]);
    GetWindowRectFn = user32.func("GetWindowRect", "int32", ["intptr_t", koffi.out(koffi.pointer(RECT))]);
    GetCursorPosFn = user32.func("GetCursorPos", "int32", [koffi.out(koffi.pointer(POINT))]);
    WindowFromPointFn = user32.func("WindowFromPoint", "intptr_t", ["PortalPOINT"]);
    OpenProcessFn = kernel32.func("OpenProcess", "intptr_t", ["uint32", "int32", "uint32"]);
    QueryFullProcessImageNameWFn = kernel32.func("QueryFullProcessImageNameW", "int32", ["intptr_t", "uint32", "void *", "void *"]);
    CloseHandleFn = kernel32.func("CloseHandle", "int32", ["intptr_t"]);

    loaded = true;
  } catch (e) {
    loaded = false;
    throw e;
  }
}

export function win32Available(): boolean {
  return process.platform === "win32";
}

export function getWindowTitle(hwnd: number): string {
  try {
    const len = GetWindowTextLengthWFn(hwnd);
    if (len <= 0) return "";
    const buf = Buffer.alloc((len + 1) * 2);
    GetWindowTextWFn(hwnd, buf, len + 1);
    return buf.toString("utf16le").replace(/\0.*$/s, "").trim();
  } catch {
    return "";
  }
}

export function getClassName(hwnd: number): string {
  try {
    const buf = Buffer.alloc(256 * 2);
    GetClassNameWFn(hwnd, buf, 256);
    return buf.toString("utf16le").replace(/\0.*$/s, "").trim();
  } catch {
    return "";
  }
}

export function getPid(hwnd: number): number {
  try {
    // GetWindowThreadProcessId returns the *thread* id; the process id is
    // written to the out-parameter (koffi marshals primitive outs via a
    // one-element array).
    const out = [0];
    GetWindowThreadProcessIdFn(hwnd, out);
    return out[0];
  } catch {
    return 0;
  }
}

export function getProcessName(pid: number): string {
  try {
    const proc = OpenProcessFn(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!proc) return "";
    try {
      const nameBuf = Buffer.alloc(1024 * 2);
      const sizeBuf = Buffer.alloc(4);
      sizeBuf.writeUInt32LE(1024, 0);
      if (QueryFullProcessImageNameWFn(proc, 0, nameBuf, sizeBuf)) {
        const full = nameBuf.toString("utf16le").replace(/\0.*$/s, "");
        return full.split(/[\\/]/).pop()?.toLowerCase() ?? "";
      }
      return "";
    } finally {
      CloseHandleFn(proc);
    }
  } catch {
    return "";
  }
}

export function isWindowVisible(hwnd: number): boolean {
  try {
    return IsWindowVisibleFn(hwnd) !== 0;
  } catch {
    return false;
  }
}

export function isWindow(hwnd: number): boolean {
  try {
    return IsWindowFn(hwnd) !== 0;
  } catch {
    return false;
  }
}

export function isToolWindow(hwnd: number): boolean {
  try {
    const ex = GetWindowLongPtrWFn(hwnd, GWL_EXSTYLE);
    return (ex & WS_EX_TOOLWINDOW) !== 0;
  } catch {
    return false;
  }
}

export function isChildWindow(hwnd: number): boolean {
  try {
    const style = GetWindowLongPtrWFn(hwnd, GWL_STYLE);
    return (style & WS_CHILD) !== 0;
  } catch {
    return false;
  }
}

export function hasOwner(hwnd: number): boolean {
  try {
    return GetWindowFn(hwnd, GW_OWNER) !== 0;
  } catch {
    return false;
  }
}

export function getWindowRect(hwnd: number): WinRect | null {
  try {
    // The RECT is marshalled out into the passed object.
    const rect: Partial<WinRect> = {};
    if (!GetWindowRectFn(hwnd, rect)) return null;
    return rect as WinRect;
  } catch {
    return null;
  }
}

export function getCursorPos(): WinPoint {
  try {
    const pt: Partial<WinPoint> = {};
    GetCursorPosFn(pt);
    return pt as WinPoint;
  } catch {
    return { x: 0, y: 0 };
  }
}

export function windowFromPoint(pt: WinPoint): number {
  try {
    return WindowFromPointFn(pt);
  } catch {
    return 0;
  }
}

export function setParent(hwnd: number, newParent: number): number {
  return SetParentFn(hwnd, newParent);
}

export function showWindow(hwnd: number, cmd: number): void {
  try {
    ShowWindowFn(hwnd, cmd);
  } catch {
    /* ignore */
  }
}

export function restoreWindow(hwnd: number): void {
  showWindow(hwnd, SW_RESTORE);
}

export function moveWindow(hwnd: number, x: number, y: number, w: number, h: number): void {
  try {
    MoveWindowFn(hwnd, Math.round(x), Math.round(y), Math.round(w), Math.round(h), 1);
  } catch {
    /* ignore */
  }
}

export function positionWindow(hwnd: number, x: number, y: number, w: number, h: number): void {
  try {
    SetWindowPosFn(hwnd, 0, Math.round(x), Math.round(y), Math.round(w), Math.round(h), SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  } catch {
    /* ignore */
  }
}

/** Like positionWindow but also raises the window to the top of the z-order. */
export function positionWindowTop(hwnd: number, x: number, y: number, w: number, h: number): void {
  try {
    // hWndInsertAfter = 0 → HWND_TOP.
    SetWindowPosFn(hwnd, 0, Math.round(x), Math.round(y), Math.round(w), Math.round(h), SWP_NOACTIVATE | SWP_SHOWWINDOW);
  } catch {
    /* ignore */
  }
}

export interface BrowserWindowEntry {
  hwnd: number;
  pid: number;
  processName: string;
  title: string;
}

/**
 * Enumerate top-level browser windows (Edge / Chrome / Firefox / …).
 * Skips our own process, tool windows, owned popups, child windows and
 * windows without a title.
 */
export function listBrowserWindows(): BrowserWindowEntry[] {
  if (!win32Available()) return [];
  try {
    ensureLoaded();
  } catch {
    return [];
  }
  const results: BrowserWindowEntry[] = [];
  const selfPid = process.pid;
  const cb = koffi.register((hwnd: number, _lparam: number) => {
    try {
      if (!IsWindowVisibleFn(hwnd)) return 1;
      if (GetWindowFn(hwnd, GW_OWNER) !== 0) return 1;
      if (isToolWindow(hwnd)) return 1;
      if (isChildWindow(hwnd)) return 1;
      const cls = getClassName(hwnd);
      if (!BROWSER_CLASSES.has(cls)) return 1;
      const pid = getPid(hwnd);
      if (!pid || pid === selfPid) return 1;
      const processName = getProcessName(pid);
      if (!BROWSER_PROCESSES.has(processName)) return 1;
      const title = getWindowTitle(hwnd);
      if (!title) return 1;
      results.push({ hwnd, pid, processName, title });
    } catch {
      /* ignore individual windows */
    }
    return 1;
  }, EnumProcType);
  try {
    EnumWindowsFn(cb, 0);
  } finally {
    try {
      koffi.unregister(cb);
    } catch {
      /* ignore */
    }
  }
  return results;
}
