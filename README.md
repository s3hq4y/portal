# Portal

![Portal](resources/portal-logo.png)

**[English](README.md)** · **[简体中文](README.zh-CN.md)**

Portal turns a local folder into a **public MCP (Model Context Protocol) endpoint** — deliberately minimal: **shell commands and file transfer only**. Connect any MCP client (Claude, ChatGPT, Cursor, a custom agent, or plain `curl`) to your machine over a tunnel, run commands, and move files.

The same idea ships in two forms in this repository:

| App | Folder | What it is |
| --- | --- | --- |
| **Portal Client** | [`client/`](client/README.md) | Standalone **Windows** desktop app (Electron + Fluent UI). No VS Code required. Adds native **browser-window docking**. |
| **Portal (VS Code extension)** | [`vscode-extension/`](vscode-extension/README.md) | The original VS Code extension. |

> 📖 Start with the README of the app you actually want to run:
> - **Client →** [`client/README.md`](client/README.md) · [简体中文](client/README.md)
> - **Extension →** [`vscode-extension/README.md`](vscode-extension/README.md) · [简体中文](vscode-extension/README.zh-CN.md)

## What you get (both forms)

| Surface | Role |
| --- | --- |
| MCP Streamable HTTP | `https://<tunnel>/mcp/<token>` |
| File HTTP API | `https://<tunnel>/files/<token>/…` (same token) |
| Exactly five tools | `run_command` · `start_command` · `read_command` · `stop_command` · `file_transfer_info` |
| Tunnels | ngrok reserved domain · Cloudflare Quick / Named · custom command |
| Localized UI | English / 简体中文 |

## Which one should I use?

- **No VS Code, want a dedicated app, or want to dock your real browser inside it?** → [`client/`](client/README.md)
- **Already live inside VS Code?** → [`vscode-extension/`](vscode-extension/README.md)

Both expose the **same MCP contract** — they are drop-in replacements for each other (and for a single folder, run one of them at a time).

## Repository layout

```
portal/
  client/             Portal Client — Electron desktop app (Windows)
  vscode-extension/   Portal — VS Code extension
  resources/          logos
  LICENSE             GNU General Public License v3
```

## License

[GNU General Public License v3](LICENSE) — GPL-3.0-or-later.
