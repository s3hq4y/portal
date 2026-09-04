# Portal Client

![Portal Client](resources/portal-logo.png)

> **⚠️ Status: Experimental** — This project is under active experimentation. Features, protocols and behavior may change at any time without notice.

**[English](README.md)** · **[简体中文](README.zh-CN.md)**

Portal Client is a standalone **Windows** desktop app (Electron + Fluent / Win10-flat UI) that exposes a local folder as a public **MCP (Model Context Protocol) endpoint** — no VS Code required. It is a self-contained port of the Portal extension, plus native **browser-window docking**.

Pick a folder → Portal runs a minimal MCP server on `127.0.0.1` (commands + file transfer) → a tunnel (ngrok / Cloudflare / custom) publishes it at a public URL like `https://…/mcp/<token>` → any MCP client (Claude, Cursor, …) connects.

## Features

### MCP (same contract as the extension — exactly five tools)

| Tool | Purpose |
| --- | --- |
| `run_command` | Foreground command. Default timeout **120s** (max 600s). Use `command` + `shell`, or `executable` + `args`. |
| `start_command` | Start a long-running process; returns `command_id` + PID. Up to four concurrent jobs. |
| `read_command` | Incremental stdout/stderr by offset; omit `command_id` to list retained jobs. |
| `stop_command` | Stop a background job and its process tree (`force` skips the 2s graceful window). |
| `file_transfer_info` | Public file-API base URL, size limit, curl examples. |

### File HTTP API

Mounted at `/files/<token>`, same tunnel and token as MCP: download / upload / delete / list / pack / unpack, with `Range`, SHA-256, ETag, path jail + deny list, atomic uploads, default cap **64 MiB**.

### Tunnels

- `ngrok-reserved` (reserved domain, optional `--pooling-enabled` load balancing)
- `cloudflare-quick` / `cloudflare-named` (token kept in OS-encrypted `safeStorage`)
- `custom` (any command, `{{port}}` / `{{token}}` / `{{workspace}}` placeholders; or attach to an existing public URL)

Tunnel binaries (ngrok / cloudflared) are auto-detected and installable in-app via winget.

### Browser docking (Windows-only)

- **Capture an existing browser window** (Edge / Chrome / Firefox / Brave / Vivaldi / Opera): click **Grab window** and click any browser window on screen, or attach from the list. The window is re-parented into the app via Win32 `SetParent` — the window itself is untouched and is **returned to the desktop, never closed**, on detach.
- **Right-docked panel**: a browser panel independent of the left nav pages, spanning the full height below the title bar, width adjustable via a draggable splitter (remembered across launches), always contained inside the main window.
- **Handle bar**: a title bar (window title + ✕ button) sits above the docked window — **drag it to tear the window out** and restore it, or click ✕ to restore it to its previous position and size.
- **Embedded browser fallback**: a built-in Chromium view (`WebContentsView`) for in-app browsing without an external browser.

### More

- **Agent Terminal**: foreground command I/O mirrored to a read-only terminal view; background jobs stream to per-task logs under `.portal/logs` (pruned after 10 minutes).
- **Activity feed + session stats + log + localized error advice** (English / 中文).
- **Prompt templates + Agent instructions** editors (`{url}` filled in on copy).
- Single instance, system tray, minimize-to-tray, optional auto-start.
- **WSL workspaces** (pick a `\\wsl.localhost\…` folder; commands run in the distro while the tunnel stays on Windows).

## Requirements

- Windows 10 / 11 (x64)
- Node.js ≥ 20 (for development/build)
- Tunnel binaries (optional, installable in-app): **ngrok** (`ngrok-reserved` needs `ngrok config` auth) · **cloudflared**

## Run (development)

```bash
npm install
npm run dev        # build + launch
```

Other scripts:

```bash
npm run build      # tsc + copy assets → dist/
npm run typecheck  # type-check only
npm run dist       # electron-builder → NSIS installer (release/)
```

## Usage

1. Open the app → on **Overview** click **Choose…** and pick a folder.
2. Click **Start** → once the tunnel is up, copy the public URL (`https://…/mcp/<token>`).
3. Paste the URL into any MCP client (Claude / Cursor / a custom agent).
4. (Optional) click the **Browser** toggle on the left: enter a URL for the built-in browser, or **Grab** an already-open browser window to dock it on the right.

## Project layout

```
client/
  src/shared/        types, i18n (EN/ZH), IPC contract
  src/main/          main process: bridge, MCP server, tunnel, tools,
                     files API, browser capture/embed
  src/main/browser/  win32.ts (koffi FFI), capture-manager.ts, embed-manager.ts
  src/preload.ts     contextBridge API
  src/renderer/      Fluent UI (index.html, styles.css, app.js)
  resources/         icons + logo
  scripts/           build asset copy
```

## Notes

- The MCP server binds **127.0.0.1 only**; the tunnel is the sole public entry point.
- The route token is a 32-hex secret embedded in the public URL — **treat it like a password**.
- Background command logs are pruned after 10 minutes; at most 4 background jobs run concurrently.
- Browser-window capture is Windows-only (Win32); the built-in browser works everywhere (though the app currently targets Windows).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
