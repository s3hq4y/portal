# Portal

![Portal](./resources/portal-logo.png)

**[English](README.md)** · **[简体中文](README.zh-CN.md)**

Portal is a VS Code extension that exposes the current workspace as a **public MCP endpoint**. It is deliberately small: **commands and file transfer only**.

Connect any MCP client (Claude, ChatGPT, Cursor, a custom agent, `curl`) to your machine over a tunnel. The agent can run shells and move files. It cannot edit text through MCP tools — there are none.

## What you get

| Surface | Role |
| --- | --- |
| MCP Streamable HTTP | `https://<tunnel>/mcp/<token>` |
| File HTTP API | `https://<tunnel>/files/<token>/…` (same token) |
| Sidebar + settings | Flat Win10-style panel: start/stop, copy URL, tunnel health |
| Portal Agent terminal | Optional live mirror of `run_command` I/O |

## MCP tools (exactly five)

| Tool | Purpose |
| --- | --- |
| `run_command` | Foreground command. Default timeout **120s** (max 600s). Use `command` + `shell`, or `executable` + `args` (preferred when you do not need shell syntax). |
| `start_command` | Start a long-running process. Returns `command_id` and PID. Up to four concurrent jobs. |
| `read_command` | Incremental stdout/stderr by offset. Omit `command_id` to list retained jobs. Completed records expire after 10 minutes. |
| `stop_command` | Stop a background job and its process tree (`force` skips the 2s graceful window). |
| `file_transfer_info` | Public file-API base URL, size limit, and curl examples. |

**Shells:** `powershell` (Windows default), `pwsh`, `cmd`, `bash` / `sh` (Git Bash when present). UTF-8 is set up automatically.

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

## Design notes

Portal is a slim fork of [nexus-bridge](https://github.com/s3hq4y/nexus-bridge):

- MCP text tools and the Python client distribution (`/client/<token>/…`) are gone.
- Shortcuts, prompt templates, and AI-launcher buttons are gone.
- Sidebar and settings use a flat Windows 10 look: square controls, Segoe UI, Win10 semantic colors.

Protocol: MCP **2024-11-05**, Streamable HTTP (JSON or one-shot SSE). CORS is open; TLS terminates at the tunnel.

## License

MIT
