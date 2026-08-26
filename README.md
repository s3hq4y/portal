# Portal

![Portal](resources/portal-logo.png)

**[English](README.md)** · **[简体中文](README.zh-CN.md)**

Portal is a VS Code extension that exposes the current workspace as a **public MCP endpoint**. It is deliberately small: **commands and file transfer only**.

Connect any MCP client (Claude, ChatGPT, Cursor, a custom agent, `curl`) to your machine over a tunnel. The agent can run shells and move files.

## What's new in 1.0.2

- **Prompt templates** — pre-author prompts that embed your link: use `{url}` as a placeholder and Portal substitutes the live public MCP URL when the prompt is copied. Manage them in the settings page (Prompts section), copy them from the sidebar quick-copy strip, or run **Portal: Copy Prompt Template**. Providers with a fixed hostname (ngrok reserved / CF named / custom attach) even get the URL predicted while Portal is stopped.
- **Error doctor** — startup and crash output is scanned for known failures (e.g. ngrok `ERR_NGROK_334` "endpoint already online", authtoken problems, Cloudflare token rejection, busy local ports, missing binaries). Portal shows a **what happened + how to fix it** card in the sidebar and settings page, with a link to the official error page for every `ERR_NGROK_*` code.
- **Portal logo in the activity bar** — the sidebar icon now uses the portal logo mark (theme-colored).
- **File API robustness fixes** — a `?glob=` listing can no longer freeze the whole server: WSL recursive listings now prune `node_modules`/`.git`/hidden directories at traversal time and are bounded by a timeout and entry cap; the glob matcher was rewritten (linear-time regex, standard `*` / `**` semantics) after a pathological backtracking loop could hang the handler on some patterns.

## What you get

| Surface | Role |
| --- | --- |
| MCP Streamable HTTP | `https://<tunnel>/mcp/<token>` |
| File HTTP API | `https://<tunnel>/files/<token>/…` (same token) |
| Sidebar + settings | start/stop, copy URL, tunnel health |
| Portal Agent terminal | Optional live mirror of `run_command` I/O |

## MCP tools (exactly five)

| Tool | Purpose |
| --- | --- |
| `run_command` | Foreground command. Default timeout **120s** (max 600s). Use `command` + `shell`, or `executable` + `args` (preferred when you do not need shell syntax). |
| `start_command` | Start a long-running process. Returns `command_id` and PID. Up to four concurrent jobs. |
| `read_command` | Incremental stdout/stderr by offset. Omit `command_id` to list retained jobs. Completed records expire after 10 minutes. |
| `stop_command` | Stop a background job and its process tree (`force` skips the 2s graceful window). |
| `file_transfer_info` | Public file-API base URL, size limit, and curl examples. |

**Shells:** `powershell` (Windows default on a local folder), `pwsh`, `cmd`, `bash` / `sh` (Git Bash when present). UTF-8 is set up automatically.

**WSL:** If the window is a WSL folder, Portal still runs on Windows (so the tunnel keeps using Windows ngrok/cloudflared). Default commands and the HTTP file API go through `wsl.exe` into that distro. Do not treat `/home/...` as a path on the Windows drive.

**Session:** reuse the `Mcp-Session-Id` from `initialize`. If it is lost or rejected, initialize again — do not invent an ID.

There are **no** `read_file` / `write_file` / `edit_file` / `list_*` / `search_files` tools. Read and write with the shell or the HTTP file API.

## File transfer (bidirectional HTTP)

Same tunnel and token as MCP. Default max size: **64 MiB** (`portal.maxTransferBytes`). Uploads replace atomically. Downloads support `Range` and return SHA-256.

```
GET    {base}?op=info              capability + workspace
GET    {base}?glob=**/*            list files
GET    {base}/<relpath>            download
HEAD   {base}/<relpath>            metadata
PUT    {base}/<relpath>            upload
DELETE {base}/<relpath>            delete
POST   {base}?op=pack              zip  JSON { "paths": ["src"] }
POST   {base}?op=unpack&dest=.     unzip (raw zip body)
```

Free ngrok domains need the header `ngrok-skip-browser-warning: 1`.

```bash
# download
curl -fsSL -H "ngrok-skip-browser-warning: 1" \
  "$BASE/README.md" -o README.md

# upload
curl -fsSL -H "ngrok-skip-browser-warning: 1" \
  -T ./photo.png "$BASE/incoming/photo.png"

# pack a folder
curl -fsSL -H "ngrok-skip-browser-warning: 1" \
  -H "Content-Type: application/json" \
  -d '{"paths":["src"]}' "$BASE?op=pack" -o src.zip
```

## Tunnel providers

| Provider | URL | Notes |
| --- | --- | --- |
| `cloudflare-quick` (default) | new random `trycloudflare.com` each start | Fast to try; not stable |
| `cloudflare-named` | fixed hostname | Needs stored Tunnel token, public hostname, **fixed local port** |
| `ngrok-reserved` | reserved domain (e.g. `*.ngrok-free.dev`) | Persistent URL |
| `custom` | your command or an existing URL | Placeholders: `{{port}}` `{{token}}` `{{workspace}}`. Empty command + `customTunnelUrl` = attach mode |

Route token is the secret path segment. MCP lives at `/mcp/<token>`. Leave `portal.routeToken` empty to generate one on start.

## Commands (palette)

- **Portal: Start / Stop**
- **Portal: Copy URL**
- **Portal: Copy Prompt Template**
- **Portal: Check Tunnel**
- **Portal: Settings**
- **Portal: Install cloudflared** / **Install/Upgrade ngrok**
- **Portal: Show Log** / **Show Agent Terminal**

Useful settings: `portal.startOnActivation` (default on), `portal.showCommandsInTerminal`, `portal.localPort` (`0` = auto, except named Cloudflare).

## Build

Requires Node 18+ and VS Code `^1.95.0`.

```bash
npm install
npm run build      # esbuild → dist/extension.js
npm run typecheck
npm run package    # .vsix (no bundled node_modules)
```

Load the packaged VSIX, or run the extension in a desktop VS Code host (`extensionKind`: `ui` + `workspace`).

## License

MIT
