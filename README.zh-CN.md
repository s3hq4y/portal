# Portal

![Portal](resources/portal-logo.png)

**[English](README.md)** · **[简体中文](README.zh-CN.md)**

Portal 把本地文件夹变成一个 **公开 MCP（Model Context Protocol）端点**——刻意做得很小：**只有命令执行和文件传输**。任意 MCP 客户端（Claude、ChatGPT、Cursor、自写 Agent，或者直接用 `curl`）都能通过隧道连到你的机器：跑命令、搬文件。

同一个理念，本仓库提供两种形态：

| 应用 | 目录 | 是什么 |
| --- | --- | --- |
| **Portal Client** | [`client/`](client/README.md) | 独立的 **Windows** 桌面应用（Electron + Fluent UI），不依赖 VS Code，额外支持**原生浏览器窗口停靠**。 |
| **Portal（VS Code 扩展）** | [`vscode-extension/`](vscode-extension/README.zh-CN.md) | 最初的 VS Code 扩展。 |

> 📖 请直接阅读你要用的那个应用的 README：
> - **Client →** [`client/README.md`](client/README.md)（中文）
> - **扩展 →** [`vscode-extension/README.zh-CN.md`](vscode-extension/README.zh-CN.md)（中文） · [English](vscode-extension/README.md)

## 两种形态都提供

| 面 | 作用 |
| --- | --- |
| MCP Streamable HTTP | `https://<隧道>/mcp/<令牌>` |
| 文件 HTTP API | `https://<隧道>/files/<令牌>/…`（同一令牌） |
| 恰好五个工具 | `run_command` · `start_command` · `read_command` · `stop_command` · `file_transfer_info` |
| 隧道 | ngrok 预留域名 · Cloudflare Quick / Named · 自定义命令 |
| 界面本地化 | English / 简体中文 |

> ⚠️ **测试状态** —— 目前只有 **ngrok** 这一种隧道方式经过实际测试。Cloudflare Quick / Named 隧道以及自定义隧道命令虽已实现，但**尚未测试**，请视为实验性功能，遇到问题欢迎提 issue。

## 我该用哪一个？

- **不想装/开 VS Code，想要独立应用，或者想把真正的浏览器窗口停靠进来？** → [`client/`](client/README.md)
- **日常就泡在 VS Code 里？** → [`vscode-extension/`](vscode-extension/README.zh-CN.md)

两者暴露的是**同一套 MCP 协议**，可以互相替换（同一个文件夹同一时刻跑其中一个即可）。

## 仓库结构

```
portal/
  client/             Portal Client —— Electron 桌面应用（Windows）
  vscode-extension/   Portal —— VS Code 扩展
  resources/          徽标
  LICENSE             GNU 通用公共许可证 v3
```

## 许可证

[GNU 通用公共许可证 v3](LICENSE) —— GPL-3.0-or-later。
