# Portal (VS Code extension) — User Guide

Attention! : The doc is only for the reference only. If you meet any problem, please issue or contact with the author by methods in the author's personal page.

**[English](USAGE.md)** · **[简体中文](USAGE.zh-CN.md)** · back to the [extension README](README.md) · [repository root](../README.md)

> Applies to extension `1.1.0`, VS Code `^1.95.0`.
> This is the full user manual. For a 30-second overview, read the [README](README.md).

Portal turns the VS Code workspace you have open into a **public MCP (Model Context Protocol) endpoint**. Any client that speaks remote MCP (Claude, Cursor, VS Code Copilot, a custom agent, `curl`, …) can reach your machine through a tunnel and do exactly two things: **run commands** and **transfer files**. Nothing else.

---

## Contents

1. [How it works](#1-how-it-works)
2. [Prerequisites](#2-prerequisites)
3. [Installation](#3-installation)
4. [Five-minute quick start](#4-five-minute-quick-start)
5. [UI tour](#5-ui-tour)
6. [Tunnel providers](#6-tunnel-providers)
7. [Connecting an MCP client](#7-connecting-an-mcp-client)
8. [MCP tool reference](#8-mcp-tool-reference)
9. [File HTTP API reference](#9-file-http-api-reference)
10. [Multiple windows / accounts / endpoints](#10-multiple-windows--accounts--endpoints)
11. [Prompt templates & agent instructions](#11-prompt-templates--agent-instructions)
12. [Settings reference](#12-settings-reference)
13. [Command reference](#13-command-reference)
14. [Security notes](#14-security-notes)
15. [Troubleshooting](#15-troubleshooting)
16. [Building from source & debugging](#16-building-from-source--debugging)
17. [FAQ](#17-faq)

---

## 1. How it works

```
 MCP client ──HTTPS──▶ tunnel (ngrok / cloudflared / custom) ──▶ 127.0.0.1:<localPort>
 (Claude, Cursor …)    https://<host>/mcp/<token>                Portal's built-in HTTP server
                       https://<host>/files/<token>/…            ├─ MCP Streamable HTTP (JSON-RPC)
                                                                 ├─ /files transfer API
                                                                 └─ /health liveness probe
```

- The extension listens **only on loopback** (`127.0.0.1`); public exposure is entirely the tunnel's job.
- The public URL embeds a **route token** in its path: `/mcp/<token>`. The token *is* the password — whoever has the URL can run commands in your workspace.
- MCP and the file API share the same tunnel and the same token.
- Exactly **five** MCP tools are exposed: `run_command`, `start_command`, `read_command`, `stop_command`, `file_transfer_info`. There are **no** `read_file` / `write_file` / `edit_file` / `search` tools — files are read and written via the shell or the HTTP file API.

> ⚠️ **Testing status:** only the **ngrok reserved-domain** tunnel has been exercised in real use. Cloudflare Quick / Named and custom tunnels are implemented but **not thoroughly tested** — treat them as experimental.

---

## 2. Prerequisites

| Item | Requirement |
| --- | --- |
| OS | **Windows** is the primary target (default shells, auto-install and WSL handling are built around it). Non-Windows code paths exist (default shell `sh`) but are untested. |
| VS Code | `1.95.0` or newer, desktop. `extensionKind` is `ui` + `workspace`; in a Remote-WSL window the extension runs on the Windows side. |
| Tunnel binary | One of: **ngrok** (recommended; needs an account, an authtoken and one reserved domain) or **cloudflared**. Both can be installed from inside Portal via winget. |
| Network | ngrok: reachability to ngrok. cloudflared: outbound **port 7844** (UDP/QUIC preferred, TCP/HTTP2 fallback). |
| Building only | Node.js 18+, npm. |

---

## 3. Installation

The extension is not on the Marketplace (`package.json` has `private: true`); install it from a VSIX.

### 3.1 Install the VSIX

Obtain `portal-<version>.vsix` (build it yourself — see [section 16](#16-building-from-source--debugging)), then either:

```bash
code --install-extension portal-1.1.0.vsix
```

or in VS Code: **Extensions view → `…` menu → Install from VSIX…**

### 3.2 Install a tunnel binary

Open the Command Palette (`Ctrl+Shift+P`):

- **Portal: Install/Upgrade ngrok** — runs `winget install Ngrok.Ngrok`
- **Portal: Install cloudflared** — runs `winget install Cloudflare.cloudflared` (falls back to `scoop install cloudflared`)

Manual installs work too as long as the binary is on `PATH` (cloudflared is additionally probed at `C:\Program Files (x86)\cloudflared\cloudflared.exe`).

### 3.3 UI language

Sidebar, settings page and command titles follow VS Code's display language: `zh-cn` → Chinese, anything else → English.

---

## 4. Five-minute quick start

Using **ngrok with a reserved domain** (the only verified path).

1. **Prepare ngrok**
   - Sign up at [ngrok](https://dashboard.ngrok.com/), copy the token from *Your Authtoken* and run:
     ```powershell
     ngrok config add-authtoken <your authtoken>
     ```
   - Under *Domains*, claim a reserved domain (free accounts get one, e.g. `your-name.ngrok-free.dev`).
2. **Configure Portal** (Command Palette)
   - **Portal: Set Tunnel Provider...** → *ngrok reserved domain*
   - **Portal: Set ngrok Domain...** → `your-name.ngrok-free.dev`
3. **Open a folder** in VS Code (Portal cannot start without a workspace folder).
4. **Start.** `portal.startOnActivation` is on by default, so Portal starts as soon as a folder opens; otherwise run **Portal: Start** or click **Start** in the Portal sidebar (activity bar).
5. The status bar shows `Portal: ngrok · :<port>` when running. Run **Portal: Copy URL** to get something like
   ```
   https://your-name.ngrok-free.dev/mcp/3f9a…e21c
   ```
   **It contains the secret — treat it like a password.**
6. Paste the URL into your MCP client ([section 7](#7-connecting-an-mcp-client)). Once a client connects, the sidebar says "Client connected"; every tool call appears in the activity feed and command I/O is mirrored into the **Portal Agent** terminal.
7. When done, run **Portal: Stop** (or close the window). The public URL stops working immediately.

> Want to try without an ngrok account? Keep the default `cloudflare-quick`: only cloudflared is required, but the URL changes on every start and this path is not thoroughly tested.

---

## 5. UI tour

### 5.1 Activity-bar sidebar (Portal icon)

| Area | Description |
| --- | --- |
| Status header | Idle / Starting / Running / Error; the number on the right is **active requests**; the gear opens the settings page |
| Activity feed | One row per tool call: tool, command summary, duration, ok/failed. Last 200 kept |
| Session dropdown | Which **MCP session** the sidebar displays and controls ([section 10](#10-multiple-windows--accounts--endpoints)) |
| Profile dropdown | Switch the **connection profile** used by this workspace; switching while running offers a restart |
| Start / Stop | Controls the selected session |
| Stats | Calls, average latency, failures, success rate (reset on every start) |

On failure an **error-doctor** card appears: recognised error code, cause, suggested fix and a documentation link.

### 5.2 Settings page (`Portal: Settings`)

A webview, top to bottom:

1. **Public URL** with Copy / Start / Stop
2. **Connection** — tunnel provider and its fields (ngrok domain, pooling, ngrok config file, inspection port / Cloudflare hostname, Tunnel token / custom command & URL), route token, local port, auto-start, terminal mirroring
3. **Connection profiles** — new / edit / duplicate / delete / use
4. **MCP sessions** — new / edit / delete / activate
5. **Security** — **Regenerate address** (new route token; auto-restarts if running; every old URL dies)
6. **Agent instructions** — customise what clients receive on `initialize`
7. **Prompts** — manage prompt templates
8. **Tools** — lists the five exposed tools
9. **Diagnostics** — ngrok / cloudflared installed?, versions, authtoken valid?, named-tunnel config complete?; install buttons; open log

### 5.3 Status bar

One item on the right with four states: `Portal: idle` / `Portal: starting...` / `Portal: <provider> · :<local port>` (highlighted) / `Portal: error` (red). Hover shows the public URL; click opens the settings page.

### 5.4 Output channel "Portal"

Everything (start-up flow, tunnel process stdout/stderr, error advice) goes to the **Portal** output channel. **Portal: Show Log** jumps there. Start troubleshooting here.

### 5.5 "Portal Agent" terminal

With `portal.showCommandsInTerminal` (default on) Portal creates a **read-only** pseudo-terminal that mirrors `run_command` and background-command I/O live, so you can watch what the AI is doing. **Portal: Show Agent Terminal** brings it up at any time.

---

## 6. Tunnel providers

Select with `portal.tunnelProvider` (or **Portal: Set Tunnel Provider...**). **Stop Portal before switching providers.**

### 6.1 `ngrok-reserved` — ngrok reserved domain (recommended, verified)

| Setting | Meaning |
| --- | --- |
| `portal.ngrokDomain` | **Required.** Reserved domain, e.g. `your-name.ngrok-free.dev` (with or without `https://`) |
| `portal.ngrokPoolingEnabled` | Adds `--pooling-enabled`. Only when you **deliberately** run several Portal/ngrok sessions on one domain and want ngrok to load-balance them; otherwise a second session fails with `ERR_NGROK_334` |
| `portal.ngrokConfigPath` | Passed as `--config`. Point two windows at two files to use two ngrok accounts side by side |
| `portal.ngrokApiPort` | Portal reads the tunnel URL from ngrok's local inspection API (default `:4040`). `0` = scan 4040–4045 and match by domain; a second concurrent agent moves to 4041, so setting 4041 skips the wait |

Before starting, Portal checks that `ngrok version` runs and `ngrok config check` passes (authtoken configured). It then runs `ngrok http <port> --url <domain> [--config …] [--pooling-enabled]` and polls the inspection API for up to 20 s; any `ERR_NGROK_<code>` in ngrok's output fails start-up immediately with a fix suggestion.

**Free-domain browser interstitial:** free ngrok domains answer "browser-looking" requests with an HTML warning page first. MCP clients are normally unaffected; if you ever receive HTML, add the header `ngrok-skip-browser-warning: 1`.

### 6.2 `cloudflare-quick` — Cloudflare Quick Tunnel (default, lightly tested)

- No account; just cloudflared.
- **A new random `*.trycloudflare.com` URL on every start** — client configs must follow. Not for long-term use.
- Portal only reports success once it has seen the URL **and** `Registered tunnel connection` in the log; if QUIC (UDP 7844) fails it retries once with HTTP/2 (TCP 7844).
- Typical failures: outbound 7844 blocked by a firewall, or hijacked by Clash/Mihomo Fake-IP ([section 15](#15-troubleshooting)).

### 6.3 `cloudflare-named` — Cloudflare Named Tunnel (fixed hostname, lightly tested)

Requires a domain on Cloudflare.

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel** (Cloudflared type); note the **Tunnel token** from the install command.
2. Under the tunnel's **Public Hostname** add: hostname e.g. `portal.example.com`, service type `HTTP`, URL `127.0.0.1:<fixed port>`.
3. Portal settings:
   - `portal.tunnelProvider` = `cloudflare-named`
   - `portal.cloudflareDomain` = `portal.example.com`
   - `portal.localPort` = that **fixed port** (`0` is rejected)
   - In **Settings page → Connection → Cloudflare Tunnel token**, paste the token and **Save**. It is stored in VS Code **SecretStorage** (OS credential store), never in settings.json, and is redacted from logs.
4. Start. Portal runs `cloudflared tunnel run` with the token in the `TUNNEL_TOKEN` environment variable, waits for the connector to register, then GETs `https://<hostname>/mcp/<token>` until it receives **405** (proof that the public route reaches Portal's MCP server). A failure at that step almost always means a wrong Public Hostname / Origin Service.

### 6.4 `custom` — any tunnel client, or attach to an existing URL (lightly tested)

Bring your own tunnel (frp, bore, localtunnel, `ssh -R`, another ngrok account, …) or start no process at all and reuse a public URL that already exists.

| Setting | Meaning |
| --- | --- |
| `portal.customTunnelCommand` | Command template. Placeholders: `{{port}}` (local MCP port), `{{token}}` (route token), `{{workspace}}` (workspace root) |
| `portal.customTunnelShell` | Shell for the command: `default` (cmd.exe on Windows, sh elsewhere), `powershell`, `pwsh`, `cmd`, `bash` |
| `portal.customTunnelUrl` | Fixed public URL. Skips URL extraction; **empty command + URL set = attach mode** (nothing is spawned, the URL is adopted as-is) |
| `portal.customTunnelUrlPattern` | Case-insensitive regex applied to the output; capture group 1 wins when present. Default: the first http(s) URL that is not localhost/127.0.0.1 |
| `portal.customTunnelReadyPattern` | Optional regex the output must also match before the tunnel counts as ready |
| `portal.customTunnelTimeoutMs` | Start-up timeout, default 30000, minimum 5000 |

Readiness: once a URL is known, wait for `readyPattern` if set; else, with a fixed URL, the process must survive 1.5 s; else ready immediately. Exiting before ready or timing out is a failure.

**Example A — ngrok with a random domain (no reserved domain needed)**

```jsonc
{
  "portal.tunnelProvider": "custom",
  "portal.customTunnelCommand": "ngrok http {{port}} --log stdout --log-format json",
  "portal.customTunnelUrlPattern": "\"url\":\"(https://[^\"]+)\""
}
```

**Example B — attach mode: the tunnel is managed elsewhere (system service, router, reverse proxy on another box, …)**

```jsonc
{
  "portal.tunnelProvider": "custom",
  "portal.customTunnelCommand": "",
  "portal.customTunnelUrl": "https://portal.example.com",
  "portal.localPort": 8572
}
```

(In attach mode you must make sure the external tunnel forwards `https://portal.example.com` to `127.0.0.1:8572`.)

### 6.5 Route token and local port

- `portal.routeToken`: leave empty and Portal **generates a 32-hex-char random token on first start**, writes it back to user settings and reuses it forever (that is why ngrok / named-tunnel URLs are stable). To rotate: **Settings → Security → Regenerate address** or **Portal: Set Route Token...**.
- `portal.localPort`: `0` = OS-assigned free port (may differ between starts). Only Cloudflare Named and attach mode need a fixed port. A busy port fails with `EADDRINUSE`.

---

## 7. Connecting an MCP client

Portal speaks **MCP Streamable HTTP** (JSON-RPC 2.0 over HTTP POST, protocol version `2024-11-05`). Any client that accepts a "remote MCP server URL" works; no OAuth — the token in the URL is the authentication.

Get the URL via **Portal: Copy URL**, the **Copy** button on the settings page, or the status-bar tooltip.

> Client config formats below are illustrative; check each client's current docs.

**Cursor** — `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project)

```json
{
  "mcpServers": {
    "portal": { "url": "https://your-name.ngrok-free.dev/mcp/<token>" }
  }
}
```

**VS Code (Copilot agent mode)** — `.vscode/mcp.json` on another machine

```json
{
  "servers": {
    "portal": { "type": "http", "url": "https://your-name.ngrok-free.dev/mcp/<token>" }
  }
}
```

**Claude Code**

```bash
claude mcp add --transport http portal https://your-name.ngrok-free.dev/mcp/<token>
```

**Claude / ChatGPT web & desktop:** add the URL under "Connectors / custom MCP server", authentication "none".

**stdio-only clients:** bridge with `mcp-remote` or similar:

```json
{
  "mcpServers": {
    "portal": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-name.ngrok-free.dev/mcp/<token>"]
    }
  }
}
```

**Simplest way:** If the agent has network sandbox capabilities, simply send the MCP URL to the agent.

**Manual check with curl**

```bash
BASE=https://your-name.ngrok-free.dev
TOKEN=<token>

# 1) initialize — the response carries Mcp-Session-Id; send it on later requests
curl -si -X POST "$BASE/mcp/$TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2) list tools
curl -s -X POST "$BASE/mcp/$TOKEN" \
  -H "Content-Type: application/json" -H "Mcp-Session-Id: <id from step 1>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) run a command
curl -s -X POST "$BASE/mcp/$TOKEN" \
  -H "Content-Type: application/json" -H "Mcp-Session-Id: <id>" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"Get-ChildItem"}}}'
```

Protocol details (useful when writing a client):

- Only `POST /mcp/<token>` is accepted; `GET` → 405; wrong token → 404; request body cap 8 MiB (413).
- If `Accept` includes `text/event-stream` the reply is a **single-event SSE** frame (`event: message`); otherwise plain JSON.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list` (empty), `prompts/list` (empty). Anything else is a JSON-RPC error (HTTP still 200).
- JSON-RPC notifications (no `id`) get 202 and are dropped.
- `initialize` returns `instructions` = the built-in (or your custom) agent instructions plus a file-API appendix.
- `GET /health` (no token) returns `{"ok":true,"server":{…}}` — a liveness probe.
- CORS is wide open (`Access-Control-Allow-Origin: *`).

---

## 8. MCP tool reference

Common rules:

- **`cwd`** is always **workspace-relative**, default = workspace root; escaping the workspace (`..`, absolute paths) fails with `Path escapes workspace`.
- Two execution modes, **mutually exclusive**:
  - **shell mode**: `command` (one command line) + optional `shell`
  - **direct mode**: `executable` + `args[]`, no shell, no quoting/injection issues; `shell` must **not** be passed
- **`shell`** values: `powershell` (default for a local Windows folder), `pwsh` (PowerShell 7), `cmd`, `bash` / `sh` (Git Bash — `bash.exe` is searched on PATH and in the standard Git install dirs; missing → error).
- **UTF-8**: PowerShell gets console input/output encoding set to UTF-8 plus `PYTHONIOENCODING=utf-8` and `PYTHONUTF8=1`; cmd runs `chcp 65001` first; Git Bash runs with `--noprofile --norc -c`.
- PowerShell is started with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass` — **your `$PROFILE` is not loaded** (custom aliases, conda init, etc. are unavailable).
- **Output cap**: 200,000 characters per stream; beyond that the output is truncated and the process terminated with `termination_reason = output_limit`.

### 8.1 `run_command` — foreground command

| Parameter | Type | Meaning |
| --- | --- | --- |
| `command` | string | shell command line (exclusive with `executable`) |
| `executable` / `args` | string / string[] | direct mode |
| `cwd` | string | workspace-relative directory |
| `shell` | enum | see above |
| `max_duration_ms` | number | timeout, default **120000**, range 1000–**600000** |

The result text has a fixed shape:

```
metadata:
{
  "cwd": ".",
  "shell": "powershell",
  "executable": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "exit_code": 0,
  "signal": null,
  "duration_ms": 552,
  "max_duration_ms": 120000,
  "timed_out": false,
  "termination_reason": "exit",      // exit | timeout | output_limit | spawn_error | stopped
  "stdout_truncated": false,
  "stderr_truncated": false
}
stdout:
…
stderr:
…
```

The call is successful **only** when `exit_code == 0` and `termination_reason == "exit"`; otherwise the MCP result carries `isError: true` (same content). On timeout the process tree is terminated gracefully, then force-killed after 2 s.

> Do not use `run_command` for anything longer than a minute or two — many MCP clients have their own HTTP timeouts. Use the background trio below.

### 8.2 `start_command` — start a background job

Same parameters as `run_command`, but `max_duration_ms` defaults to **3,600,000** (1 h) with a cap of **86,400,000** (24 h). **At most 4 concurrent jobs**; more → `Background command limit reached (4)`.

Returns immediately:

```json
{
  "command_id": "cmd-a02f5860-…",
  "pid": 122276,
  "status": "running",            // running | exited | failed | timed_out | stopped
  "command": "npm run dev",
  "cwd": ".",
  "shell": "powershell",
  "executable": "C:\\…\\powershell.exe",
  "started_at": "2026-09-05T11:15:55.218Z",
  "max_duration_ms": 3600000,
  "log_file": ".portal/logs/20260905-191555-npm-run-dev-a02f5860.log"
}
```

Every job appends its complete stdout/stderr to **its own log file** `.portal/logs/<date-time>-<command slug>-<first 8 id chars>.log` inside the workspace (add `.portal/` to `.gitignore`), so you can `Get-Content -Wait -Tail 50 <log_file>` in a terminal of your own.

### 8.3 `read_command` — incremental output

| Parameter | Meaning |
| --- | --- |
| `command_id` | omit to get `{ "commands": [...] }` — every job still retained |
| `stdout_offset` / `stderr_offset` | the `next_offset` from the previous call; omitted = from the oldest buffered char |
| `max_chars` | max chars per stream, default 64000, range 1000–100000 |
| `wait_ms` | long-poll this long when there is no unread output and the job is still running, 0–30000 |

Returns:

```json
{
  "command": { …same as start_command; after exit also ended_at / exit_code / signal / termination_reason… },
  "stdout": {
    "text": "tick 1\r\ntick 2\r\n",
    "oldest_offset": 0,     // oldest char still buffered
    "start_offset": 0,      // where this read actually started
    "next_offset": 16,      // pass this next time
    "end_offset": 16,       // total length so far
    "truncated_before": false,  // true = the offset you asked for was already evicted
    "has_more": false
  },
  "stderr": { … }
}
```

The ring buffer holds **200,000 characters per stream**; older output lives only in the log file. Finished jobs are **retained for 10 minutes**.

### 8.4 `stop_command` — stop a background job

`{ "command_id": "...", "force": false }`. Graceful first, escalated to forceful after 2 s; `force: true` is immediate. On Windows the whole tree is killed with `taskkill /T /F`. Returns the final job info (`status: "stopped"`). Safe to call on a job that already ended.

Stopping Portal, or reloading VS Code, terminates every background job.

### 8.5 `file_transfer_info` — where the file API lives

No parameters. Returns the file API base URL, size limit, endpoint list and curl examples (i.e. section 9). Errors while Portal is not running.

### 8.6 Behaviour in WSL workspaces

If the VS Code window has a **WSL folder** open (Remote-WSL, or a `\\wsl.localhost\<distro>\…` path):

- Portal and the tunnel keep running on **Windows**; the workspace is mapped to `\\wsl.localhost\<distro>\<path>`.
- **Default commands** (no shell, or `sh` / `bash`) run **inside the distro** via `wsl.exe -d <distro> --cd <posix path> /bin/sh -lc "<command>"`; in direct mode an `executable` that does not look like a Windows program (no drive letter, no backslash, not .exe/.bat/.cmd/.com) also goes through WSL.
- Explicit `shell: "powershell"` / `"cmd"` still run on Windows.
- The file HTTP API reads and writes files inside the distro through `wsl.exe` as well.
- Do not treat `/home/...` as a path on the Windows drive.

---

## 9. File HTTP API reference

Base: `{base} = https://<host>/files/<token>` (same tunnel and token as MCP). Every `<relpath>` is **workspace-relative**, forward slashes, URL-encoded.

| Method & path | Purpose | Success |
| --- | --- | --- |
| `GET {base}?op=info` | capabilities, workspace path, size cap, endpoint table | `200` JSON |
| `GET {base}?glob=<pattern>&path=<dir>` | recursive listing (defaults `**/*`, `.`); `glob` supports `*`, `**`, `?` | `200` `{ok, root, count, files:[{path,size,mtime,kind}]}` |
| `GET {base}/<relpath>` | download; single `Range` supported (incl. suffix `bytes=-n`) | `200` / `206`, see headers |
| `HEAD {base}/<relpath>` | metadata only | `200` + same headers |
| `GET {base}/<dir>` | same as listing that directory | `200` JSON |
| `PUT {base}/<relpath>[?overwrite=false]` | upload (parents created; temp file + atomic rename) | new `201` / replaced `200`, `{ok,path,bytes,sha256,overwritten}` |
| `DELETE {base}/<relpath>` | delete a single file (directories refused) | `200` `{ok,deleted}` |
| `POST {base}?op=pack` | JSON body `{"paths":["src","README.md"]}` (omit = whole workspace) → zip | `200` `application/zip` (`workspace.zip`) |
| `POST {base}?op=unpack&dest=<dir>` | raw zip body, extracted under `dest` (default `.`) | `200` `{ok,dest,count,files}` |

**Download headers:** `Content-Type` (guessed from extension), `Content-Length`, `Accept-Ranges: bytes`, `Last-Modified`, `ETag: "<sha256>"`, `X-File-Sha256`, `X-File-Path`, `Content-Disposition: attachment`.

**Status codes**

| Code | Meaning |
| --- | --- |
| `400` | missing path, bad `Range`, overwriting/deleting a directory, parse errors, … (JSON `{ok:false,error}`) |
| `403` | path escapes the workspace (`Path escapes workspace`) or hits the deny list (`Path is blocked`) |
| `404` | file not found; wrong token |
| `409` | `overwrite=false` and the file exists |
| `413` | larger than `portal.maxTransferBytes` |

**Limits & safety rules**

- Per-transfer cap `portal.maxTransferBytes`, default **64 MiB** (min 1 MiB); `pack` totals are capped too.
- Listings return at most **2000** entries and walk for at most **10 s**.
- Listing and packing **skip** `node_modules`, `.git`, `dist`, `out` and every dot-directory (direct GET/PUT of a file inside a hidden dir still works, e.g. `.portal/logs/x.log`).
- **Deny list** (403 for every operation): anything under `.git/`, `.env` and `.env.*`, `.netrc`, `.git-credentials`, `id_rsa*`, `*.pem` / `*.pfx` / `*.p12` / `*.key`.
- `unpack` drops entries containing `..` or matching the deny list.
- Through a free ngrok domain send `ngrok-skip-browser-warning: 1`.

**curl examples**

```bash
BASE="https://your-name.ngrok-free.dev/files/<token>"
H='-H ngrok-skip-browser-warning:1'

curl -fsSL $H "$BASE?op=info"                                   # info
curl -fsSL $H "$BASE?glob=src/**/*.ts"                          # list TS files
curl -fsSL $H "$BASE/README.md" -o README.md                    # download
curl -fsSL $H -T ./photo.png "$BASE/incoming/photo.png"         # upload
curl -fsSL $H -X DELETE "$BASE/incoming/photo.png"              # delete
curl -fsSL $H -H "Content-Type: application/json" \
  -d '{"paths":["src"]}' "$BASE?op=pack" -o src.zip             # pack
curl -fsSL $H --data-binary @src.zip "$BASE?op=unpack&dest=restore"   # unpack
```

**PowerShell examples**

```powershell
$base = "https://your-name.ngrok-free.dev/files/<token>"
$h = @{ "ngrok-skip-browser-warning" = "1" }
Invoke-RestMethod "$base?op=info" -Headers $h
Invoke-WebRequest "$base/README.md" -Headers $h -OutFile README.md
Invoke-WebRequest "$base/incoming/photo.png" -Method Put -InFile .\photo.png -Headers $h
```

---

## 10. Multiple windows / accounts / endpoints

Portal has two orthogonal concepts:

| Concept | Answers | Stored |
| --- | --- | --- |
| **Connection profile** (`portal.connectionProfiles`) | *how* to tunnel: provider, domain, ngrok account (config file), port, token, … | list: **user (global) settings**; selection `portal.activeProfile`: **workspace** `.vscode/settings.json` |
| **MCP session** (`portal.tokens`) | *what* to publish: one independent endpoint = its own route token + optional workspace path + optional tunnel overrides | list: user settings; displayed session `portal.activeTokenId`: workspace |

### 10.1 Connection profiles: two windows, two ngrok accounts

1. Settings page → **Connection profiles → New**, e.g. `account-A`: provider `ngrok-reserved`, domain `a.ngrok-free.dev`, ngrok config file `C:\ngrok\a.yml`.
2. Another one, `account-B`: domain `b.ngrok-free.dev`, config file `C:\ngrok\b.yml`, inspection port `4041`.
3. Select `account-A` in window 1 and `account-B` in window 2 (sidebar dropdown / "Use" on the settings page / **Portal: Switch Connection Profile...**). Each selection is written to its own workspace; they never overwrite each other.
4. Fields **set** in a profile override the plain `portal.*` settings; unset fields fall through. Switching while running requires a restart.

Equivalent user-level settings.json:

```jsonc
"portal.connectionProfiles": [
  { "name": "account-A", "tunnelProvider": "ngrok-reserved", "ngrokDomain": "a.ngrok-free.dev", "ngrokConfigPath": "C:\\ngrok\\a.yml" },
  { "name": "account-B", "tunnelProvider": "ngrok-reserved", "ngrokDomain": "b.ngrok-free.dev", "ngrokConfigPath": "C:\\ngrok\\b.yml", "ngrokApiPort": 4041 }
]
```

Each ngrok config file only needs that account's authtoken:

```yaml
version: "3"
agent:
  authtoken: <authtoken of account A>
```

> Two reserved domains on the **same** account do **not** need two config files; only when the domains really live on two accounts (otherwise you get `ERR_NGROK_320`).

### 10.2 MCP sessions: several endpoints from one window

- **Portal: Add MCP Session** (token auto-generated) or settings page → **MCP sessions → New** (optionally set `workspacePath` to expose a different folder, and/or per-session tunnel provider / domain / port).
- The sidebar session dropdown decides what is displayed **and which session the Start/Stop button controls**. To run sessions in parallel: select A → Start, select B → Start. Switching the display does not stop a running session.
- **Portal: Select MCP Session** / **Portal: Remove MCP Session** are the Command Palette equivalents.
- With no sessions configured there is one implicit session called `default` that uses the plain `portal.*` settings — fully backward compatible.

```jsonc
"portal.tokens": [
  { "id": "main", "label": "Main repo", "routeToken": "<32 hex chars>" },
  { "id": "docs", "label": "Docs site", "routeToken": "<another>", "workspacePath": "D:\\work\\docs", "localPort": 8600 }
]
```

Several sessions on ngrok normally need distinct domains (or pooling on a shared one).

### 10.3 ngrok cheat sheet

| Scenario | Settings |
| --- | --- |
| Two windows, same account, two domains | two profiles with just `ngrokDomain`; the second may set `ngrokApiPort: 4041` to save time |
| Two windows, two accounts | additionally per-profile `ngrokConfigPath` |
| Several Portals sharing one domain (ngrok load balancing) | `ngrokPoolingEnabled: true` on all of them |

---

## 11. Prompt templates & agent instructions

### 11.1 Prompt templates (`portal.promptTemplates`)

Pre-written "kick-off" prompts that contain your link, copied in one go:

- Use **`{url}`** (single braces) as the placeholder; it is replaced with the live public MCP URL on copy.
- For **deterministic** addresses (ngrok reserved domain, Cloudflare named tunnel, custom fixed URL) the URL is predicted even while Portal is stopped, as long as a route token exists; quick tunnels require Portal to be running.
- Manage: settings page → **Prompts**; copy: **Portal: Copy Prompt Template** (opens a picker).

```jsonc
"portal.promptTemplates": [
  { "name": "Kick-off", "text": "Connect to my workspace through the MCP endpoint {url}. Run git status first and explain your plan before changing anything." }
]
```

### 11.2 Agent instructions (`portal.agentInstructions`)

On `initialize` the client receives an `instructions` string. Portal's built-in default tells the agent how to reuse the session id, how `run_command` and the background trio work, how to choose a shell, the WSL caveats, that there are no file-edit tools (use the HTTP file API) and to ask before destructive operations.

To replace it: settings page → **Agent instructions**, or edit `portal.agentInstructions` directly. Empty = default. **Takes effect on the next start.** The file-API appendix is always added at the end.

---

## 12. Settings reference

All keys live under `portal.*`.

| Key | Type / default | Meaning |
| --- | --- | --- |
| `tunnelProvider` | `ngrok-reserved` \| `cloudflare-quick` \| `cloudflare-named` \| `custom` / **`cloudflare-quick`** | tunnel provider |
| `ngrokDomain` | string / `""` | reserved domain, required for `ngrok-reserved` |
| `ngrokPoolingEnabled` | boolean / `false` | pass `--pooling-enabled` |
| `ngrokConfigPath` | string / `""` | pass `--config`; multi-account |
| `ngrokApiPort` | number / `0` | inspection port to read the tunnel list from; `0` scans 4040–4045 |
| `cloudflareDomain` | string / `""` | public hostname of the named tunnel |
| `customTunnelCommand` | string / `""` | custom command template (`{{port}}` `{{token}}` `{{workspace}}`) |
| `customTunnelShell` | `default` \| `powershell` \| `pwsh` \| `cmd` \| `bash` / `default` | shell for the custom command |
| `customTunnelUrl` | string / `""` | fixed public URL; attach mode when the command is empty |
| `customTunnelUrlPattern` | string / `""` | regex to extract the URL |
| `customTunnelReadyPattern` | string / `""` | readiness regex |
| `customTunnelTimeoutMs` | number / `30000` (min 5000) | custom tunnel start-up timeout |
| `routeToken` | string / `""` | route token; generated and written back on first start when empty |
| `localPort` | number / `0` | local MCP port; `0` auto; fixed port required for named tunnels |
| `startOnActivation` | boolean / `true` | start when a workspace opens |
| `showCommandsInTerminal` | boolean / `true` | mirror into the Portal Agent terminal |
| `maxTransferBytes` | number / `67108864` (min 1 MiB) | file-API per-transfer cap |
| `promptTemplates` | `{name,text}[]` / `[]` | prompt templates |
| `agentInstructions` | string / `""` | custom initialize instructions |
| `connectionProfiles` | `ConnectionProfile[]` / `[]` | connection profile list (user level) |
| `activeProfile` | string / `""` | profile used by this workspace (workspace level) |
| `tokens` | `MCPTokenProfile[]` / `[]` | MCP session list |
| `activeTokenId` | string / `""` | session shown in the sidebar (workspace level) |

`ConnectionProfile` fields: `name` (required) plus optional `tunnelProvider`, `ngrokDomain`, `ngrokPoolingEnabled`, `ngrokConfigPath`, `ngrokApiPort`, `cloudflareDomain`, `customTunnel*`, `routeToken`, `localPort`, `maxTransferBytes`.

`MCPTokenProfile` fields: `id` (required), `label`, `routeToken` (empty = inherit), `workspacePath`, and the same tunnel-override fields as a profile.

One secret that is *not* in settings.json: the **Cloudflare Tunnel token** — it can only be written to SecretStorage via the settings page.

---

## 13. Command reference

| Command | ID | Notes |
| --- | --- | --- |
| Portal: Start | `portal.start` | start the current session (hidden while running) |
| Portal: Stop | `portal.stop` | stop the current session (hidden while idle) |
| Portal: Restart | `portal.restart` | stop + start (after switching profiles) |
| Portal: Settings | `portal.showPanel` | open the settings page |
| Portal: Copy URL | `portal.copyUrl` | copy the public MCP URL (requires running) |
| Portal: Copy Prompt Template | `portal.copyPrompt` | pick a template and copy it (`{url}` substituted) |
| Portal: Check Tunnel | `portal.checkTunnel` | re-probe ngrok/cloudflared, authtoken, named-tunnel config |
| Portal: Install cloudflared | `portal.installCloudflared` | winget (scoop fallback) |
| Portal: Install/Upgrade ngrok | `portal.installNgrok` | winget |
| Portal: Set Tunnel Provider... | `portal.setTunnelProvider` | quick pick (stop first) |
| Portal: Set ngrok Domain... | `portal.setNgrokDomain` | input box |
| Portal: Set Route Token... | `portal.setRouteToken` | input box (masked) |
| Portal: Show Log | `portal.showLog` | open the Portal output channel |
| Portal: Show Agent Terminal | `portal.showAgentTerminal` | open the mirror terminal |
| Portal: Switch Connection Profile... | `portal.switchProfile` | pick a profile (written to the workspace) |
| Portal: Select MCP Session | `portal.tokenSelect` | choose the session the sidebar shows |
| Portal: Add MCP Session | `portal.tokenAdd` | enter a label; token auto-generated |
| Portal: Remove MCP Session | `portal.tokenRemove` | delete from the list |

---

## 14. Security notes

Please understand these before using Portal:

1. **The URL is the credential.** Anyone holding `https://<host>/mcp/<token>` can **run arbitrary commands** under your Windows account in your workspace (`cwd` is jailed to the workspace, but a command can `cd` anywhere) and read/write workspace files through the file API. Never paste the URL into public channels, screenshots or logs.
2. **There is no second factor.** No OAuth, no IP allow-list, CORS wide open. Security rests entirely on token secrecy and the tunnel's TLS.
3. **The token is persistent.** The auto-generated token is written to user settings and reused. If you suspect a leak, **Regenerate address**; when not in use, **Stop** Portal (or turn off `startOnActivation` so VS Code does not expose you the moment it opens).
4. **The file-API deny list is best-effort.** It blocks `.git`, `.env`, private keys and similar, but not every credential you might keep in a workspace — and `run_command` can read any file anyway. Treat the workspace as "fully accessible to the AI".
5. **Watch it.** Keep the Portal Agent terminal open and an eye on the activity feed. The default agent instructions ask the AI to confirm before destructive operations, but that depends on the client model honouring it.
6. **`/health` needs no token** and exposes only `{"ok":true,"server":{"name":"portal","version":"1.0.0"}}`.
7. **Corporate networks / compliance.** This publishes a shell on an internal machine to the internet — make sure your organisation's policy allows it.
8. The Cloudflare Tunnel token is kept in VS Code SecretStorage (Windows Credential Manager); the ngrok authtoken is managed by ngrok's own config file; both are redacted from logs.

---

## 15. Troubleshooting

**Step one is always: Portal: Show Log.** Error-doctor cards from the sidebar / settings page are written there too.

| Symptom / error | Cause & fix |
| --- | --- |
| `Open a workspace folder before starting Portal.` | No folder open; Portal needs a workspace root |
| `Stop Portal before switching tunnel provider.` | Providers cannot change while running |
| `ERR_NGROK_334` (endpoint already online) | The domain is still held by another ngrok session (unclean exit, another machine, another window). Close the old session at dashboard.ngrok.com → Endpoints, or kill leftover `ngrok.exe`, then retry. To run several on purpose: enable `ngrokPoolingEnabled` |
| `ERR_NGROK_320` (domain belongs to another account) | Domain and current authtoken are from different accounts. Set the right account's `ngrokConfigPath` for this window/profile, or use another domain |
| `ngrok authtoken is missing or invalid` | `ngrok config add-authtoken <token>`; with `ngrokConfigPath`, check that file |
| `ngrok is not installed` / `Tunnel executable not found` | **Portal: Install/Upgrade ngrok** (or cloudflared) or fix PATH; then **Portal: Check Tunnel** |
| `[ngrok] timeout waiting for API on :4040/…; assuming https://…` | No tunnel seen on the inspection API within 20 s; Portal optimistically adopts the expected URL. With several ngrok agents, set `ngrokApiPort: 4041` in the second window |
| Occasional `502` + `ERR_NGROK_8012` at the client | One connection from the ngrok edge to local Portal failed — usually transient, just retry. If persistent: is Portal still running (status bar)? did the tunnel process exit (log)? |
| The client receives an HTML page instead of JSON | ngrok free-domain interstitial. Add header `ngrok-skip-browser-warning: 1` |
| `Cloudflare Edge is unreachable on outbound UDP/TCP port 7844` | Firewall/proxy blocks 7844. Allow it or change networks |
| `… intercepted by Clash/Mihomo Fake-IP (198.18.0.0/15) …` | The proxy's Fake-IP hijacks Cloudflare's edge. Add `+.argotunnel.com` to `fake-ip-filter` and route `*.argotunnel.com` DIRECT |
| `cloudflared did not report a trycloudflare URL within 30s.` | Network issue or odd cloudflared build. Run `cloudflared tunnel --url http://127.0.0.1:1234` by hand and read the output |
| `Cloudflare Named Tunnel requires a fixed local port` | Set `portal.localPort` to the port configured as the Cloudflare origin service |
| `Cloudflare Named Tunnel token is missing` / `Cloudflare rejected the Tunnel token` | Save the correct token on the settings page (re-copy it from the Zero Trust dashboard) |
| `The connector registered, but the public hostname did not reach the MCP server: HTTP 4xx/5xx` | Wrong Public Hostname or Origin Service; it must be `http://127.0.0.1:<localPort>` and the hostname must equal `cloudflareDomain` |
| `Local port is already in use` (`EADDRINUSE`) | Change `portal.localPort` or stop whatever holds the port |
| `Set portal.customTunnelCommand, or portal.customTunnelUrl for attach mode` | The custom provider needs a command or a fixed URL |
| `The custom tunnel did not become ready within 30000ms` | No URL / readyPattern match in the output. Read the `[custom:out]` lines in the log and adjust `customTunnelUrlPattern`, or raise `customTunnelTimeoutMs` |
| `ls -la` fails inside `run_command` | The default Windows shell is PowerShell, where `ls` aliases `Get-ChildItem` and does not accept `-la`. Use PowerShell syntax or `shell: "bash"` (Git Bash) |
| Aliases / functions / conda env not found | PowerShell runs with `-NoProfile`. Activate explicitly (e.g. `& conda shell.powershell hook` before `conda activate`) or use full paths |
| `Path escapes workspace` | `cwd` or a file path left the workspace |
| `Background command limit reached (4)` | `stop_command` something or wait for a job to finish |
| `truncated_before: true` | The offset was evicted from the 200k ring buffer; read the full output from `log_file` |
| Address did not change after switching profiles | The tunnel reads its config only at start — run **Portal: Restart** |
| `{url}` not substituted when copying a prompt | Quick tunnels cannot be predicted while stopped — start first; make sure you used single braces `{url}` |

---

## 16. Building from source & debugging

```bash
cd vscode-extension
npm install
npm run build        # esbuild → dist/extension.js (with sourcemap)
npm run typecheck    # tsc --noEmit
npm run package      # portal-<version>.vsix (vsce package --no-dependencies)
npm run watch        # continuous build while developing
```

Debugging: the repo ships no `.vscode/launch.json`; a minimal one lets you press `F5` for an Extension Development Host:

```jsonc
// vscode-extension/.vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Portal Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

Source map (`src/`):

| File | Responsibility |
| --- | --- |
| `extension.ts` | entry point: commands, UI mounting, auto-start |
| `session-hub.ts` | one `BridgeManager` per MCP session, in parallel |
| `bridge-manager.ts` | lifecycle of one session: HTTP server → tunnel → stats & activity feed |
| `mcp-server.ts` | hand-rolled MCP Streamable HTTP (JSON-RPC) server, default agent instructions |
| `tunnel.ts` | ngrok / cloudflared quick / named / custom start-up, readiness, process cleanup |
| `tools/` | the five tools, process spawning, background registry |
| `files/` | HTTP file API, path safety (workspace jail + deny list), zip, WSL I/O |
| `config.ts` · `profiles.ts` | settings access, profile/session overlay logic |
| `settings-page.ts` · `sidebar/panel.ts` · `status-bar.ts` · `agent-terminal.ts` | UI |
| `error-doctor.ts` | known errors → fix suggestions |
| `nls.ts` · `package.nls*.json` | English / Chinese strings |

---

## 17. FAQ

**Why are there no `read_file` / `write_file` tools?**
A deliberate trade-off: a smaller tool surface is harder for agents to misuse and simpler to serve. Read with `run_command` (`Get-Content`, `type`, `cat`) or the file API `GET`; write with the file API `PUT` (atomic, SHA-256 returned) or shell redirection.

**How does the AI learn the file API address?**
The `initialize` instructions end with it, and `file_transfer_info` returns the complete endpoint table with examples.

**Can I run Portal Client (desktop) and this extension on the same folder at the same time?**
Not recommended — they are two shapes of the same MCP contract; run one at a time.

**Does the URL change?**
ngrok reserved domain, Cloudflare named tunnel, custom fixed URL: stable as long as the route token stays. Cloudflare quick tunnel: new on every start.

**Do background jobs survive a Portal stop?**
No. Stop / restart / window reload terminates all of them.

**macOS / Linux?**
Non-Windows branches exist (default shell `sh`, no auto-install) but the author has only tested on Windows.

**Do several VS Code windows interfere?**
Each window is an independent extension instance. Use **connection profiles** to give each window its own domain/account; the selection is stored per workspace.

**What is the `.portal/` directory?**
Background job logs (`.portal/logs/*.log`). Safe to delete; add it to `.gitignore` (this repo already does).

**MCP protocol version?**
The server reports `2024-11-05`; clients initialising with a newer version still negotiate fine (Portal does not validate strictly).

---

*Written for Portal extension 1.1.0; the source code is authoritative.*
