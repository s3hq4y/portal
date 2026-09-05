# Portal（VS Code 扩展）使用文档

注：本文档仅供参考，如果使用过程中存在问题请 issue 或用主页方式联系作者。

**[English](USAGE.md)** · **[简体中文](USAGE.zh-CN.md)** · 返回 [扩展 README](README.zh-CN.md) · [仓库首页](../README.zh-CN.md)

> 适用版本：扩展 `1.1.0`，VS Code `^1.95.0`。
> 本文是面向使用者的完整手册；想 30 秒了解项目是什么，请看 [README](README.zh-CN.md)。

Portal 把你当前打开的 VS Code 工作区变成一个 **公开的 MCP（Model Context Protocol）端点**，任何支持远程 MCP 的客户端（Claude、Cursor、VS Code Copilot、自写 Agent、`curl`……）都能通过隧道连到你的机器：**执行命令**、**传输文件**——就这两件事，没有别的。

---

## 目录

1. [工作原理](#1-工作原理)
2. [前置条件](#2-前置条件)
3. [安装](#3-安装)
4. [五分钟上手](#4-五分钟上手)
5. [界面导览](#5-界面导览)
6. [隧道提供方配置](#6-隧道提供方配置)
7. [把 MCP 客户端连上来](#7-把-mcp-客户端连上来)
8. [MCP 工具参考](#8-mcp-工具参考)
9. [文件 HTTP API 参考](#9-文件-http-api-参考)
10. [多窗口 / 多账号 / 多端点](#10-多窗口--多账号--多端点)
11. [提示词模板与 Agent 提示词](#11-提示词模板与-agent-提示词)
12. [设置项完整参考](#12-设置项完整参考)
13. [命令面板完整参考](#13-命令面板完整参考)
14. [安全须知](#14-安全须知)
15. [故障排查](#15-故障排查)
16. [从源码构建与调试](#16-从源码构建与调试)
17. [常见问题](#17-常见问题)

---

## 1. 工作原理

```
 MCP 客户端 ──HTTPS──▶ 隧道 (ngrok / cloudflared / 自定义) ──▶ 127.0.0.1:<localPort>
 (Claude, Cursor …)     https://<host>/mcp/<token>              Portal 内置 HTTP 服务
                        https://<host>/files/<token>/…          ├─ MCP Streamable HTTP（JSON-RPC）
                                                                ├─ /files 文件传输 API
                                                                └─ /health 存活探针
```

- 扩展在本机 **只监听回环地址** `127.0.0.1`，对外暴露完全依赖隧道。
- 公开 URL 的路径里嵌着一个 **路由令牌（route token）**：`/mcp/<token>`。令牌就是密码，拿到 URL 的人就能在你的工作区里跑命令。
- MCP 与文件 API 共用同一个隧道、同一个令牌。
- 扩展 **恰好** 暴露 5 个 MCP 工具：`run_command`、`start_command`、`read_command`、`stop_command`、`file_transfer_info`。**没有** `read_file` / `write_file` / `edit_file` / `search` 之类的工具——读写文件要么走 shell，要么走 HTTP 文件 API。

> ⚠️ **测试状态**：目前只有 **ngrok 预留域名** 这一种隧道方式经过实际使用验证。Cloudflare Quick / Named 与自定义隧道已实现但**未充分测试**，请当作实验性功能。

---

## 2. 前置条件

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **Windows** 是主要目标平台（默认 shell、自动安装、WSL 支持都是围绕 Windows 做的）。代码里有非 Windows 分支（默认 shell 为 `sh`），但未经测试。 |
| VS Code | `1.95.0` 及以上，桌面版。扩展 `extensionKind` 为 `ui` + `workspace`，在 Remote-WSL 窗口中会运行在 Windows 侧。 |
| 隧道工具 | 二选一即可：**ngrok**（推荐，需要账号 + authtoken + 一个预留域名）或 **cloudflared**。都可以通过 Portal 的命令用 winget 一键安装。 |
| 网络 | ngrok：能访问 ngrok 服务即可。cloudflared：需要出站 **7844 端口**（UDP/QUIC 优先，TCP/HTTP2 兜底）。 |
| 只在从源码构建时 | Node.js 18+，npm。 |

---

## 3. 安装

扩展目前不在 Marketplace 上（`package.json` 里 `private: true`），通过 VSIX 安装。

### 3.1 安装 VSIX

拿到 `portal-<版本>.vsix`（自行构建见 [第 16 节](#16-从源码构建与调试)），然后任选一种方式：

```bash
code --install-extension portal-1.1.0.vsix
```

或者在 VS Code 里：**扩展视图 → 右上角 `…` → 从 VSIX 安装…**。

### 3.2 安装隧道工具

安装完扩展后，打开命令面板（`Ctrl+Shift+P`）：

- **Portal：安装/升级 ngrok** —— 执行 `winget install Ngrok.Ngrok`
- **Portal：安装 cloudflared** —— 执行 `winget install Cloudflare.cloudflared`（失败时回退到 `scoop install cloudflared`）

也可以手动安装，只要二进制在 `PATH` 里即可（cloudflared 额外会探测 `C:\Program Files (x86)\cloudflared\cloudflared.exe`）。

### 3.3 界面语言

侧边栏、设置页、命令名称会跟随 VS Code 的显示语言：`zh-cn` 显示中文，其他显示英文。

---

## 4. 五分钟上手

下面以 **ngrok 预留域名**（唯一经过验证的方式）为例。

1. **准备 ngrok**
   - 注册 [ngrok](https://dashboard.ngrok.com/)，在 *Your Authtoken* 页复制令牌，在终端执行：
     ```powershell
     ngrok config add-authtoken <你的 authtoken>
     ```
   - 在 *Domains* 页申请一个预留域名（免费账号可以有 1 个，形如 `your-name.ngrok-free.dev`）。
2. **配置 Portal**（命令面板）
   - **Portal：设置隧道提供方...** → 选 *ngrok 预留域名*
   - **Portal：设置 ngrok 域名...** → 填 `your-name.ngrok-free.dev`
3. **在 VS Code 里打开一个文件夹**（没有工作区文件夹 Portal 无法启动）。
4. **启动**：默认 `portal.startOnActivation` 为开，打开文件夹后 Portal 会自动启动；也可以手动 **Portal：启动**，或在活动栏的 Portal 侧边栏点 **启动**。
5. 状态栏右下角出现 `Portal: ngrok · :<端口>` 即表示运行中。执行 **Portal：复制 URL**，得到形如
   ```
   https://your-name.ngrok-free.dev/mcp/3f9a…e21c
   ```
   的地址——**它包含密钥，请像密码一样保管。**
6. 把 URL 填进 MCP 客户端（见 [第 7 节](#7-把-mcp-客户端连上来)）。客户端连上后侧边栏会显示"客户端已连接"，之后 AI 每次调用工具都会出现在活动流里；命令的输入输出会同步镜像到 **Portal Agent** 终端。
7. 用完执行 **Portal：停止**（或关闭 VS Code 窗口）。停止后公开 URL 立即失效。

> 想先试试而不注册 ngrok？保留默认的 `cloudflare-quick`，只需安装 cloudflared 即可启动，但每次启动 URL 都会变，且该路径未经充分测试。

---

## 5. 界面导览

### 5.1 活动栏侧边栏（Portal 图标）

| 区域 | 说明 |
| --- | --- |
| 顶部状态 | 空闲 / 启动中 / 运行中 / 错误；右侧数字为**进行中的请求数**；齿轮按钮打开设置页 |
| 活动流 | 每一次工具调用一条记录：工具名、命令摘要、耗时、成功/失败。最多保留 200 条 |
| 会话下拉框 | 选择侧边栏当前显示/控制哪个 **MCP 会话**（见 [第 10 节](#10-多窗口--多账号--多端点)） |
| 档案下拉框 | 切换当前工作区使用的 **连接配置档案**；运行中切换会提示重启 |
| 启动 / 停止 | 控制当前选中的会话 |
| 统计 | 调用次数、平均耗时、失败次数、成功率（每次启动清零） |

出错时会显示 **错误医生** 卡片：识别出的错误码、原因、建议修复步骤，以及官方文档链接。

### 5.2 设置页（`Portal：设置`）

一个 Webview 页面，从上到下：

1. **公开 URL** + 复制 / 启动 / 停止
2. **连接**：隧道提供方及其专属字段（ngrok 域名、pooling、ngrok 配置文件、inspection 端口 / Cloudflare 主机名、Tunnel Token / 自定义命令与 URL）、路由令牌、本地端口、自动启动、镜像到终端
3. **连接配置档案**：新建 / 编辑 / 复制 / 删除 / 使用
4. **MCP 会话**：新建 / 编辑 / 删除 / 激活
5. **安全**：**重新生成地址**（换一个路由令牌；运行中会自动重启；旧 URL 全部失效）
6. **Agent 提示词**：自定义 `initialize` 时下发给客户端的说明
7. **提示词**：管理提示词模板
8. **工具**：列出暴露的 5 个工具
9. **诊断**：ngrok / cloudflared 是否安装、版本、authtoken 是否有效、命名隧道配置是否齐全；安装按钮；打开日志

### 5.3 状态栏

右侧一项，四种状态：`Portal: idle` / `Portal: starting...` / `Portal: <提供方> · :<本地端口>`（高亮）/ `Portal: error`（红底）。悬停显示公开 URL；点击打开设置页。

### 5.4 输出面板 "Portal"

所有日志（启动流程、隧道进程的 stdout/stderr、错误建议）都写到输出通道 **Portal**。**Portal：显示日志** 直达。排障先看这里。

### 5.5 "Portal Agent" 终端

`portal.showCommandsInTerminal`（默认开）为真时，Portal 会创建一个**只读**伪终端，实时镜像 `run_command` 和后台命令的输入输出，让你看着 AI 在干什么。**Portal：显示 Agent 终端** 可以随时调出。

---

## 6. 隧道提供方配置

用 `portal.tunnelProvider` 选择（或命令 **Portal：设置隧道提供方...**）。**切换提供方前必须先停止 Portal。**

### 6.1 `ngrok-reserved` —— ngrok 预留域名（推荐，已验证）

| 设置 | 说明 |
| --- | --- |
| `portal.ngrokDomain` | **必填。** 预留域名，如 `your-name.ngrok-free.dev`（可带或不带 `https://`） |
| `portal.ngrokPoolingEnabled` | 给 ngrok 加 `--pooling-enabled`。仅当你**有意**让多个 Portal/ngrok 会话共用同一域名并由 ngrok 负载均衡时打开；否则第二个会话会报 `ERR_NGROK_334` |
| `portal.ngrokConfigPath` | 传给 ngrok 的 `--config` 文件路径。两个窗口用两个 ngrok 账号时，各指向一个配置文件 |
| `portal.ngrokApiPort` | Portal 通过 ngrok 本地 inspection API（默认 `:4040`）读取隧道 URL。`0` = 自动扫描 4040–4045 并按域名匹配；同时跑第二个 ngrok 时它会挪到 4041，填 4041 可以省掉等待 |

启动前 Portal 会检查：`ngrok version` 可执行、`ngrok config check` 通过（即 authtoken 已配置）。启动时执行 `ngrok http <port> --url <domain> [--config …] [--pooling-enabled]`，然后轮询 inspection API 最多 20 秒确认 URL；若 ngrok 输出里出现 `ERR_NGROK_<code>` 会立刻失败并给出解决建议。

**免费域名的浏览器警告页**：ngrok 免费域名对"看起来像浏览器"的请求会先返回一个 HTML 警告页。MCP 客户端一般不受影响；如果遇到返回 HTML 的情况，给请求加头 `ngrok-skip-browser-warning: 1`。

### 6.2 `cloudflare-quick` —— Cloudflare 快速隧道（默认值，未充分测试）

- 无需账号，只要安装 cloudflared。
- **每次启动都是新的随机 `*.trycloudflare.com` 地址**，客户端配置得跟着改；不适合长期使用。
- Portal 只有在同时看到 URL **且** 日志出现 `Registered tunnel connection` 时才算启动成功；QUIC（UDP 7844）失败会自动用 HTTP/2（TCP 7844）重试一次。
- 常见失败：出站 7844 被防火墙拦、被 Clash/Mihomo 的 Fake-IP 劫持（见 [第 15 节](#15-故障排查)）。

### 6.3 `cloudflare-named` —— Cloudflare 命名隧道（固定主机名，未充分测试）

前提：你有一个托管在 Cloudflare 的域名。

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel**（Cloudflared 类型），记下安装命令里的 **Tunnel token**（很长的一串）。
2. 在隧道的 **Public Hostname** 里添加一条：主机名如 `portal.example.com`，服务类型 `HTTP`，URL `127.0.0.1:<固定端口>`。
3. Portal 设置：
   - `portal.tunnelProvider` = `cloudflare-named`
   - `portal.cloudflareDomain` = `portal.example.com`
   - `portal.localPort` = 上面那个 **固定端口**（`0` 不行）
   - 在 **设置页 → 连接 → Cloudflare Tunnel token** 粘贴令牌并 **保存**。令牌保存在 VS Code 的 **SecretStorage**（系统凭据库），不会写进 settings.json，也不会出现在日志里。
4. 启动。Portal 通过环境变量 `TUNNEL_TOKEN` 运行 `cloudflared tunnel run`，等连接器注册后，还会对 `https://<主机名>/mcp/<token>` 发 GET 直到收到 **405**（说明公网路径确实打到了 Portal 的 MCP 服务）才报告成功；这一步失败通常是 Public Hostname / Origin Service 配错。

### 6.4 `custom` —— 自定义隧道 / 接入已有隧道（未充分测试）

给你带任意隧道客户端（frp、bore、localtunnel、`ssh -R`、其他 ngrok 账号……）或者根本不启动进程、直接使用一个已经存在的公网地址。

| 设置 | 说明 |
| --- | --- |
| `portal.customTunnelCommand` | 要运行的命令模板。占位符：`{{port}}`（本地 MCP 端口）、`{{token}}`（路由令牌）、`{{workspace}}`（工作区根目录） |
| `portal.customTunnelShell` | 运行命令用的 shell：`default`（Windows = cmd.exe，其他 = sh）、`powershell`、`pwsh`、`cmd`、`bash` |
| `portal.customTunnelUrl` | 固定公网 URL。设置后不再从输出提取 URL；**命令为空 + 设置了 URL = 接入模式**（不 spawn 任何进程，直接采用该 URL） |
| `portal.customTunnelUrlPattern` | 从命令输出提取 URL 的正则（大小写不敏感）；有捕获组 1 时取组 1。默认：第一个不是 localhost/127.0.0.1 的 http(s) URL |
| `portal.customTunnelReadyPattern` | 可选正则；输出还需匹配它才算就绪 |
| `portal.customTunnelTimeoutMs` | 启动超时，默认 30000，最小 5000 |

就绪判定规则：拿到 URL 后，若配置了 `readyPattern` 则等它匹配；否则若是固定 URL，进程需存活 1.5 秒；否则立即就绪。进程在就绪前退出、或超时，都算失败。

**示例 A —— 用随机域名的 ngrok（无需预留域名）**

```jsonc
{
  "portal.tunnelProvider": "custom",
  "portal.customTunnelCommand": "ngrok http {{port}} --log stdout --log-format json",
  "portal.customTunnelUrlPattern": "\"url\":\"(https://[^\"]+)\""
}
```

**示例 B —— 接入模式：隧道由别处管理（系统服务、路由器、另一台机器的反代……）**

```jsonc
{
  "portal.tunnelProvider": "custom",
  "portal.customTunnelCommand": "",
  "portal.customTunnelUrl": "https://portal.example.com",
  "portal.localPort": 8572
}
```

（接入模式下你要自己保证外部隧道把 `https://portal.example.com` 转发到 `127.0.0.1:8572`。）

### 6.5 路由令牌与本地端口

- `portal.routeToken`：留空则**首次启动时自动生成** 32 位十六进制随机串并写回用户设置，以后一直复用（所以 ngrok/命名隧道的 URL 是稳定的）。要换地址用 **设置页 → 安全 → 重新生成地址** 或命令 **Portal：设置路由令牌...**。
- `portal.localPort`：`0` = 由系统分配空闲端口（每次可能不同）。只有 Cloudflare 命名隧道和接入模式需要固定端口。端口被占会报 `EADDRINUSE`。

---

## 7. 把 MCP 客户端连上来

Portal 讲的是 **MCP Streamable HTTP** 传输（JSON-RPC 2.0 over HTTP POST，协议版本 `2024-11-05`）。任何支持"远程 MCP 服务器 URL"的客户端都能用，不需要 OAuth——URL 里的令牌就是认证。

拿 URL 的三种方式：**Portal：复制 URL**、设置页顶部的 **复制**、状态栏悬停。

> 下列客户端配置格式以各客户端当前文档为准，这里只给出形态示意。

**Cursor** —— `~/.cursor/mcp.json`（或项目内 `.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "portal": { "url": "https://your-name.ngrok-free.dev/mcp/<token>" }
  }
}
```

**VS Code（Copilot Agent 模式）** —— 另一台机器上的 `.vscode/mcp.json`

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

**Claude / ChatGPT 网页端 & 桌面端**：在"连接器 / Connectors / 自定义 MCP 服务器"里填 URL，认证选"无"。

**只支持 stdio 的客户端**：用 `mcp-remote` 之类的桥接器：

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

**最简单方式**：如果 agent 具备网络沙盒能力，直接将 mcp url 发给 agent 即可。

**用 curl 手动验证**

```bash
BASE=https://your-name.ngrok-free.dev
TOKEN=<token>

# 1) initialize —— 响应头里会带 Mcp-Session-Id，后续请求要带上
curl -si -X POST "$BASE/mcp/$TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2) 列工具
curl -s -X POST "$BASE/mcp/$TOKEN" \
  -H "Content-Type: application/json" -H "Mcp-Session-Id: <上一步的 id>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) 跑一条命令
curl -s -X POST "$BASE/mcp/$TOKEN" \
  -H "Content-Type: application/json" -H "Mcp-Session-Id: <id>" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_command","arguments":{"command":"Get-ChildItem"}}}'
```

协议细节（写客户端时有用）：

- 只接受 `POST /mcp/<token>`；`GET` 返回 405；令牌不对返回 404；请求体上限 8 MiB（超出 413）。
- `Accept` 含 `text/event-stream` 时以**单事件 SSE**（`event: message`）返回，否则返回普通 JSON。
- 支持的方法：`initialize`、`ping`、`tools/list`、`tools/call`、`resources/list`（空）、`prompts/list`（空）。其他方法返回 JSON-RPC 错误（HTTP 仍是 200）。
- JSON-RPC 通知（无 `id`）返回 202 并被丢弃。
- `initialize` 返回的 `instructions` = 内置（或你自定义的）Agent 提示词 + 文件 API 地址附录。
- `GET /health`（不需要令牌）返回 `{"ok":true,"server":{…}}`，可做存活探针。
- CORS 全开（`Access-Control-Allow-Origin: *`）。

---

## 8. MCP 工具参考

通用规则：

- **`cwd`** 一律是**工作区相对路径**，默认工作区根；试图跳出工作区（`..`、绝对路径）会报错 `Path escapes workspace`。
- 两种执行模式，**二选一**：
  - **shell 模式**：`command`（一整行命令）+ 可选 `shell`
  - **直接模式**：`executable` + `args[]`，不经过 shell，没有引号/注入问题；此时**不能**传 `shell`
- **`shell`** 可选值：`powershell`（Windows 本地文件夹的默认值）、`pwsh`（PowerShell 7）、`cmd`、`bash` / `sh`（Git Bash，会在 PATH 和标准 Git 安装目录里找 `bash.exe`；找不到报错）。
- **UTF-8**：PowerShell 会设置控制台输入输出编码为 UTF-8 并注入 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`；cmd 会先 `chcp 65001`；Git Bash 以 `--noprofile --norc -c` 运行。
- PowerShell 以 `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass` 启动 —— **不会加载你的 `$PROFILE`**（自定义别名、conda init 等不可用）。
- **输出上限**：每个流 200,000 字符；超出则截断并终止进程，`termination_reason` = `output_limit`。

### 8.1 `run_command` —— 前台命令

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `command` | string | shell 命令行（与 `executable` 互斥） |
| `executable` / `args` | string / string[] | 直接模式 |
| `cwd` | string | 工作区相对目录 |
| `shell` | enum | 见上 |
| `max_duration_ms` | number | 超时，默认 **120000**，范围 1000–**600000** |

返回文本固定格式：

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

**只有** `exit_code == 0` 且 `termination_reason == "exit"` 时结果才是成功，否则 MCP 结果带 `isError: true`（内容不变）。超时时先优雅终止，2 秒后强杀整棵进程树。

> 超过一两分钟的任务不要用 `run_command`——很多 MCP 客户端自己有 HTTP 超时。用下面的后台三件套。

### 8.2 `start_command` —— 启动后台任务

参数同 `run_command`，但 `max_duration_ms` 默认 **3,600,000**（1 小时），上限 **86,400,000**（24 小时）。**最多同时 4 个**，超出报错 `Background command limit reached (4)`。

立即返回：

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

每个后台任务把完整 stdout/stderr 追加写到**自己的日志文件** `.portal/logs/<日期-时间>-<命令片段>-<id 前 8 位>.log`（位于工作区内，请把 `.portal/` 加进 `.gitignore`），可以在自己的终端里 `Get-Content -Wait -Tail 50 <log_file>` 跟踪。

### 8.3 `read_command` —— 增量读取输出

| 参数 | 说明 |
| --- | --- |
| `command_id` | 省略则返回 `{ "commands": [...] }` 列出所有仍保留的任务 |
| `stdout_offset` / `stderr_offset` | 上次返回的 `next_offset`；省略 = 从缓冲区最旧处读 |
| `max_chars` | 每个流最多返回的字符数，默认 64000，范围 1000–100000 |
| `wait_ms` | 没有新输出且任务仍在运行时长轮询等待的毫秒数，0–30000 |

返回：

```json
{
  "command": { …同 start_command 的信息，任务结束后多出 ended_at / exit_code / signal / termination_reason… },
  "stdout": {
    "text": "tick 1\r\ntick 2\r\n",
    "oldest_offset": 0,     // 缓冲区里最旧字符的偏移
    "start_offset": 0,      // 本次实际起点
    "next_offset": 16,      // 下次传这个
    "end_offset": 16,       // 当前总长度
    "truncated_before": false,  // true = 你要的起点已被环形缓冲区淘汰
    "has_more": false
  },
  "stderr": { … }
}
```

环形缓冲区每流 **200,000 字符**，更早的内容只能去日志文件里找。任务结束后记录**保留 10 分钟**再清理。

### 8.4 `stop_command` —— 停止后台任务

`{ "command_id": "...", "force": false }`。默认先优雅终止，2 秒后升级为强制；`force: true` 直接强制。Windows 上用 `taskkill /T /F` 杀整棵进程树。返回任务最终信息（`status` 为 `stopped`）。对已经结束的任务调用也安全。

Portal 停止或 VS Code 重载时，所有后台任务都会被终止。

### 8.5 `file_transfer_info` —— 文件 API 地址

无参数。返回文件 API 的基址、大小上限、端点清单和 curl 示例（内容即第 9 节）。Portal 未运行时返回错误。

### 8.6 WSL 工作区的行为

如果 VS Code 窗口打开的是 **WSL 里的文件夹**（Remote-WSL，或 `\\wsl.localhost\<发行版>\…` 路径）：

- Portal 本身和隧道仍然跑在 **Windows** 上；工作区映射为 `\\wsl.localhost\<发行版>\<路径>`。
- **默认命令**（未指定 shell，或 `sh` / `bash`）通过 `wsl.exe -d <发行版> --cd <posix 路径> /bin/sh -lc "<命令>"` 在**发行版里**执行；直接模式下，`executable` 看起来不是 Windows 程序（无盘符、无反斜杠、不是 .exe/.bat/.cmd/.com）时也进 WSL。
- 显式 `shell: "powershell"` / `"cmd"` 仍在 Windows 上执行。
- 文件 HTTP API 也经由 `wsl.exe` 读写发行版内的文件。
- 不要把 `/home/...` 当成 Windows 盘上的路径。

---

## 9. 文件 HTTP API 参考

基址：`{base} = https://<host>/files/<token>`（与 MCP 同隧道、同令牌）。所有 `<relpath>` 都是**工作区相对路径**，正斜杠，URL 编码。

| 方法 & 路径 | 作用 | 成功响应 |
| --- | --- | --- |
| `GET {base}?op=info` | 能力信息、工作区路径、大小上限、端点表 | `200` JSON |
| `GET {base}?glob=<pattern>&path=<dir>` | 递归列出文件（默认 `**/*`、`.`）；`glob` 支持 `*`、`**`、`?` | `200` `{ok, root, count, files:[{path,size,mtime,kind}]}` |
| `GET {base}/<relpath>` | 下载；支持单段 `Range`（含 `bytes=-n` 后缀形式） | `200` / `206`，见响应头 |
| `HEAD {base}/<relpath>` | 只要元数据 | `200` + 同样的响应头 |
| `GET {base}/<目录>` | 等同列出该目录 | `200` JSON |
| `PUT {base}/<relpath>[?overwrite=false]` | 上传（自动创建父目录；写临时文件再原子改名） | 新建 `201` / 覆盖 `200`，`{ok,path,bytes,sha256,overwritten}` |
| `DELETE {base}/<relpath>` | 删除单个文件（拒绝删目录） | `200` `{ok,deleted}` |
| `POST {base}?op=pack` | 请求体 JSON `{"paths":["src","README.md"]}`（省略 = 整个工作区），返回 zip | `200` `application/zip`（`workspace.zip`） |
| `POST {base}?op=unpack&dest=<dir>` | 请求体为原始 zip，解压到 `dest`（默认 `.`） | `200` `{ok,dest,count,files}` |

**下载响应头**：`Content-Type`（按扩展名猜测）、`Content-Length`、`Accept-Ranges: bytes`、`Last-Modified`、`ETag: "<sha256>"`、`X-File-Sha256`、`X-File-Path`、`Content-Disposition: attachment`。

**状态码**

| 码 | 含义 |
| --- | --- |
| `400` | 缺路径、`Range` 非法、试图覆盖/删除目录、解析失败等（JSON `{ok:false,error}`） |
| `403` | 路径跳出工作区（`Path escapes workspace`）或命中拒绝列表（`Path is blocked`） |
| `404` | 文件不存在；令牌不对 |
| `409` | `overwrite=false` 且文件已存在 |
| `413` | 超过 `portal.maxTransferBytes` |

**限制与安全规则**

- 单次传输上限 `portal.maxTransferBytes`，默认 **64 MiB**（最低 1 MiB）；`pack` 的总大小也受此限制。
- 列表最多返回 **2000** 个条目、最多遍历 **10 秒**。
- 列表和打包会**跳过** `node_modules`、`.git`、`dist`、`out` 以及所有以 `.` 开头的目录（直接按路径 GET/PUT 隐藏目录里的文件仍然可以，例如 `.portal/logs/x.log`）。
- **拒绝列表**（任何操作都 403）：`.git/` 目录内一切、`.env` 及 `.env.*`、`.netrc`、`.git-credentials`、`id_rsa*`、`*.pem` / `*.pfx` / `*.p12` / `*.key`。
- `unpack` 会丢弃包含 `..` 或命中拒绝列表的条目。
- 经免费 ngrok 域名访问时请带头 `ngrok-skip-browser-warning: 1`。

**curl 示例**

```bash
BASE="https://your-name.ngrok-free.dev/files/<token>"
H='-H ngrok-skip-browser-warning:1'

curl -fsSL $H "$BASE?op=info"                                   # 信息
curl -fsSL $H "$BASE?glob=src/**/*.ts"                          # 列 TS 文件
curl -fsSL $H "$BASE/README.md" -o README.md                    # 下载
curl -fsSL $H -T ./photo.png "$BASE/incoming/photo.png"         # 上传
curl -fsSL $H -X DELETE "$BASE/incoming/photo.png"              # 删除
curl -fsSL $H -H "Content-Type: application/json" \
  -d '{"paths":["src"]}' "$BASE?op=pack" -o src.zip             # 打包
curl -fsSL $H --data-binary @src.zip "$BASE?op=unpack&dest=restore"   # 解包
```

**PowerShell 示例**

```powershell
$base = "https://your-name.ngrok-free.dev/files/<token>"
$h = @{ "ngrok-skip-browser-warning" = "1" }
Invoke-RestMethod "$base?op=info" -Headers $h
Invoke-WebRequest "$base/README.md" -Headers $h -OutFile README.md
Invoke-WebRequest "$base/incoming/photo.png" -Method Put -InFile .\photo.png -Headers $h
```

---

## 10. 多窗口 / 多账号 / 多端点

Portal 有两个彼此正交的概念：

| 概念 | 回答的问题 | 存储位置 |
| --- | --- | --- |
| **连接配置档案**（`portal.connectionProfiles`） | *怎么* 出隧道：提供方、域名、ngrok 账号（配置文件）、端口、令牌…… | 列表：**用户（全局）设置**；当前选择 `portal.activeProfile`：**工作区** `.vscode/settings.json` |
| **MCP 会话**（`portal.tokens`） | *发布什么*：一个独立端点 = 自己的路由令牌 + 可选的工作区路径 + 可选的隧道覆盖 | 列表：用户设置；当前显示 `portal.activeTokenId`：工作区 |

### 10.1 连接配置档案：两个窗口用两个 ngrok 账号

1. 设置页 → **连接配置档案 → 新建**，例如 `account-A`：提供方 `ngrok-reserved`、域名 `a.ngrok-free.dev`、ngrok 配置文件 `C:\ngrok\a.yml`。
2. 再建 `account-B`：域名 `b.ngrok-free.dev`、配置文件 `C:\ngrok\b.yml`、inspection 端口 `4041`。
3. 在窗口 1 选 `account-A`，窗口 2 选 `account-B`（侧边栏下拉框 / 设置页"使用" / 命令 **Portal：切换连接配置档案…**）。选择写进各自工作区，互不覆盖。
4. 档案里**填了**的字段覆盖普通 `portal.*` 设置，没填的沿用。运行中切换需要重启 Portal 生效。

等价的 settings.json（用户级）：

```jsonc
"portal.connectionProfiles": [
  { "name": "account-A", "tunnelProvider": "ngrok-reserved", "ngrokDomain": "a.ngrok-free.dev", "ngrokConfigPath": "C:\\ngrok\\a.yml" },
  { "name": "account-B", "tunnelProvider": "ngrok-reserved", "ngrokDomain": "b.ngrok-free.dev", "ngrokConfigPath": "C:\\ngrok\\b.yml", "ngrokApiPort": 4041 }
]
```

每个 ngrok 配置文件里只需要各自账号的 authtoken：

```yaml
version: "3"
agent:
  authtoken: <账号 A 的 authtoken>
```

> 同一账号的两个预留域名**不需要**两个配置文件；只有域名真的分属两个账号时才需要（否则会报 `ERR_NGROK_320`）。

### 10.2 MCP 会话：一个窗口发布多个端点

- **Portal：添加 MCP 会话**（自动生成令牌）或设置页 → **MCP 会话 → 新建**（可填 `workspacePath` 让这个会话暴露另一个文件夹，也可以单独指定隧道提供方/域名/端口）。
- 侧边栏的会话下拉框决定当前显示、以及 **启动/停止按钮控制的是哪一个**。要并行运行：选会话 A → 启动，再选会话 B → 启动。已启动的会话在切换显示时不会被停掉。
- **Portal：选择 MCP 会话** / **Portal：移除 MCP 会话** 是对应的命令面板入口。
- 没有配置任何会话时，就是一个名为 `default` 的隐式会话，使用普通 `portal.*` 设置——与旧版本完全兼容。

```jsonc
"portal.tokens": [
  { "id": "main",  "label": "主仓库", "routeToken": "<32 位 hex>" },
  { "id": "docs",  "label": "文档站", "routeToken": "<另一个>", "workspacePath": "D:\\work\\docs", "localPort": 8600 }
]
```

多个会话如果都用 ngrok，通常需要不同的域名（或开启 pooling 共用一个域名）。

### 10.3 ngrok 三件套速查

| 场景 | 需要的设置 |
| --- | --- |
| 两个窗口、同一账号、两个域名 | 两个档案只填 `ngrokDomain`；第二个可填 `ngrokApiPort: 4041` 省时间 |
| 两个窗口、两个账号 | 再加各自的 `ngrokConfigPath` |
| 多个 Portal 共用一个域名（ngrok 负载均衡） | `ngrokPoolingEnabled: true`，且所有会话都要开 |

---

## 11. 提示词模板与 Agent 提示词

### 11.1 提示词模板（`portal.promptTemplates`）

预先写好带链接的"开场提示词"，发给 AI 时一键复制：

- 文本里用 **`{url}`**（单层花括号）作占位符，复制时替换成当前公开 MCP 地址。
- 对 ngrok 预留域名 / Cloudflare 命名隧道 / 自定义固定 URL 这类**确定性地址**，即使 Portal 没在运行、只要路由令牌已存在，也能预测出 URL 直接复制；快速隧道则必须先启动。
- 管理：设置页 → **提示词**；复制：**Portal：复制提示词模板**（会弹出选择器）。

```jsonc
"portal.promptTemplates": [
  { "name": "开工", "text": "通过 MCP 端点 {url} 连接到我的工作区。先运行 git status 看看现状，改动前先说明计划。" }
]
```

### 11.2 Agent 提示词（`portal.agentInstructions`）

MCP 客户端在 `initialize` 时会收到一段 `instructions`，Portal 内置的默认版本告诉 Agent：如何复用会话 ID、`run_command` 与后台命令的用法、shell 的选择、WSL 的注意事项、没有文件编辑工具要走 HTTP 文件 API、破坏性操作前先询问。

想换成自己的：设置页 → **Agent 提示词** 里填写并保存，或直接编辑 `portal.agentInstructions`。留空 = 用默认。**下次启动 Portal 时生效。** 无论自定义与否，文件 API 地址附录都会附在末尾。

---

## 12. 设置项完整参考

所有键都在 `portal.*` 下。"作用域"一列：用户 = 通常放用户设置；工作区 = Portal 自己会写到 `.vscode/settings.json`。

| 键 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `tunnelProvider` | `ngrok-reserved` \| `cloudflare-quick` \| `cloudflare-named` \| `custom` / **`cloudflare-quick`** | 隧道提供方 |
| `ngrokDomain` | string / `""` | ngrok 预留域名，`ngrok-reserved` 必填 |
| `ngrokPoolingEnabled` | boolean / `false` | 传 `--pooling-enabled` |
| `ngrokConfigPath` | string / `""` | 传 `--config`；用于多账号 |
| `ngrokApiPort` | number / `0` | 读取隧道列表的 inspection 端口；`0` 扫描 4040–4045 |
| `cloudflareDomain` | string / `""` | 命名隧道的公开主机名 |
| `customTunnelCommand` | string / `""` | 自定义命令模板（`{{port}}` `{{token}}` `{{workspace}}`） |
| `customTunnelShell` | `default` \| `powershell` \| `pwsh` \| `cmd` \| `bash` / `default` | 运行自定义命令的 shell |
| `customTunnelUrl` | string / `""` | 固定公网 URL；命令为空时 = 接入模式 |
| `customTunnelUrlPattern` | string / `""` | 提取 URL 的正则 |
| `customTunnelReadyPattern` | string / `""` | 就绪判定正则 |
| `customTunnelTimeoutMs` | number / `30000`（最小 5000） | 自定义隧道启动超时 |
| `routeToken` | string / `""` | 路由令牌；空则首次启动自动生成并写回 |
| `localPort` | number / `0` | 本地 MCP 端口；`0` 自动；命名隧道必须固定 |
| `startOnActivation` | boolean / `true` | 打开工作区自动启动 |
| `showCommandsInTerminal` | boolean / `true` | 镜像到 Portal Agent 终端 |
| `maxTransferBytes` | number / `67108864`（最小 1 MiB） | 文件 API 单次上限 |
| `promptTemplates` | `{name,text}[]` / `[]` | 提示词模板 |
| `agentInstructions` | string / `""` | 自定义 initialize 提示词 |
| `connectionProfiles` | `ConnectionProfile[]` / `[]` | 连接配置档案列表（用户级） |
| `activeProfile` | string / `""` | 当前工作区使用的档案名（工作区级） |
| `tokens` | `MCPTokenProfile[]` / `[]` | MCP 会话列表 |
| `activeTokenId` | string / `""` | 侧边栏当前显示的会话 id（工作区级） |

`ConnectionProfile` 可用字段：`name`（必填）以及 `tunnelProvider`、`ngrokDomain`、`ngrokPoolingEnabled`、`ngrokConfigPath`、`ngrokApiPort`、`cloudflareDomain`、`customTunnel*`、`routeToken`、`localPort`、`maxTransferBytes`（都可选）。

`MCPTokenProfile` 可用字段：`id`（必填）、`label`、`routeToken`（空则沿用全局）、`workspacePath`，以及与档案相同的隧道覆盖字段。

未在上面出现的一个秘密：**Cloudflare Tunnel token** 不在 settings.json 里，只能通过设置页写入 SecretStorage。

---

## 13. 命令面板完整参考

| 命令（中文界面） | ID | 说明 |
| --- | --- | --- |
| Portal：启动 | `portal.start` | 启动当前会话（运行中时隐藏） |
| Portal：停止 | `portal.stop` | 停止当前会话（未运行时隐藏） |
| Portal：重启 | `portal.restart` | 停止再启动（切换档案后用） |
| Portal：设置 | `portal.showPanel` | 打开设置页 |
| Portal：复制 URL | `portal.copyUrl` | 复制公开 MCP 地址（需运行中） |
| Portal：复制提示词模板 | `portal.copyPrompt` | 选择模板并复制（`{url}` 已替换） |
| Portal：检查隧道 | `portal.checkTunnel` | 重新探测 ngrok/cloudflared 安装状态、authtoken、命名隧道配置 |
| Portal：安装 cloudflared | `portal.installCloudflared` | winget（回退 scoop） |
| Portal：安装/升级 ngrok | `portal.installNgrok` | winget |
| Portal：设置隧道提供方... | `portal.setTunnelProvider` | 快速选择（需先停止） |
| Portal：设置 ngrok 域名... | `portal.setNgrokDomain` | 输入框 |
| Portal：设置路由令牌... | `portal.setRouteToken` | 输入框（密码形式） |
| Portal：显示日志 | `portal.showLog` | 打开输出通道 Portal |
| Portal：显示 Agent 终端 | `portal.showAgentTerminal` | 打开镜像终端 |
| Portal：切换连接配置档案… | `portal.switchProfile` | 选择档案（写入工作区） |
| Portal：选择 MCP 会话 | `portal.tokenSelect` | 切换侧边栏显示的会话 |
| Portal：添加 MCP 会话 | `portal.tokenAdd` | 输入标签，自动生成令牌 |
| Portal：移除 MCP 会话 | `portal.tokenRemove` | 从列表删除 |

---

## 14. 安全须知

请在理解以下几点后再使用：

1. **URL 即凭据。** 拿到 `https://<host>/mcp/<token>` 的任何人都可以以你的 Windows 账户权限、在你的工作区里**执行任意命令**（`cwd` 被限制在工作区内，但命令本身可以 `cd` 到任何地方），以及通过文件 API 读写工作区文件。不要把 URL 贴到公开渠道、截图、日志。
2. **没有第二道认证。** 没有 OAuth、没有 IP 白名单、CORS 全开。安全性完全依赖令牌的保密性和隧道的 TLS。
3. **令牌是持久的。** 自动生成的令牌会写进用户设置并一直复用。怀疑泄露就 **重新生成地址**；不用的时候 **停止** Portal（或关掉 `startOnActivation`，避免一打开 VS Code 就对外暴露）。
4. **文件 API 的拒绝列表是尽力而为。** 它挡住了 `.git`、`.env`、私钥等常见敏感文件，但挡不住你工作区里其他形式的凭据；而且 `run_command` 本来就能读任何文件。把工作区当成"AI 可以完全访问"的区域。
5. **看着它跑。** 保持 Portal Agent 终端打开，关注侧边栏活动流；内置 Agent 提示词要求 AI 在破坏性操作前先询问，但这取决于客户端模型是否遵守。
6. **`/health` 不需要令牌**，只暴露 `{"ok":true,"server":{"name":"portal","version":"1.0.0"}}`。
7. **公司网络/合规。** 这是把一台内网机器的 shell 暴露到公网，请确认符合你所在组织的策略。
8. Cloudflare Tunnel token 存在 VS Code SecretStorage（Windows 凭据管理器）；ngrok authtoken 由 ngrok 自己的配置文件保管；日志中会把这些令牌打码。

---

## 15. 故障排查

**第一步永远是：Portal：显示日志。** 侧边栏 / 设置页出现的错误医生卡片也会同步写到日志里。

| 现象 / 错误 | 原因与处理 |
| --- | --- |
| `Open a workspace folder before starting Portal.` | 没有打开文件夹。Portal 需要一个工作区根目录 |
| `Stop Portal before switching tunnel provider.` | 运行中不能切提供方，先停止 |
| `ERR_NGROK_334`（endpoint already online） | 这个域名还被另一个 ngrok 会话占着（上次未干净退出、另一台机器、另一个窗口）。去 dashboard.ngrok.com → Endpoints 关掉旧会话，或结束残留 `ngrok.exe` 进程后重试。确实要多开：开 `ngrokPoolingEnabled` |
| `ERR_NGROK_320`（domain belongs to another account） | 域名与当前 authtoken 不是同一账号。给这个窗口/档案设置正确账号的 `ngrokConfigPath`，或换域名 |
| `ngrok authtoken is missing or invalid` | 执行 `ngrok config add-authtoken <token>`；用了 `ngrokConfigPath` 就检查那个文件 |
| `ngrok is not installed` / `Tunnel executable not found` | 用 **Portal：安装/升级 ngrok**（或 cloudflared），或修 PATH；装完 **Portal：检查隧道** 重新探测 |
| `[ngrok] timeout waiting for API on :4040/…; assuming https://…` | 20 秒内没从 inspection API 读到隧道；Portal 会乐观地采用预期 URL。多开 ngrok 时给第二个窗口设 `ngrokApiPort: 4041` |
| 客户端偶发 `502` + `ERR_NGROK_8012` | ngrok 边缘到本地 Portal 的一次连接失败，通常是瞬时的，重试即可。若持续：看状态栏 Portal 是否还在运行、日志里隧道进程是否退出 |
| 客户端收到一个 HTML 页面而不是 JSON | ngrok 免费域名的浏览器警告页。加请求头 `ngrok-skip-browser-warning: 1` |
| `Cloudflare Edge is unreachable on outbound UDP/TCP port 7844` | 防火墙/代理挡了 7844。放行，或换网络 |
| `… intercepted by Clash/Mihomo Fake-IP (198.18.0.0/15) …` | 代理的 Fake-IP 劫持了 Cloudflare 边缘。把 `+.argotunnel.com` 加进 `fake-ip-filter`，并让 `*.argotunnel.com` 走 DIRECT |
| `cloudflared did not report a trycloudflare URL within 30s.` | 网络问题或 cloudflared 版本异常。手动跑 `cloudflared tunnel --url http://127.0.0.1:1234` 看输出 |
| `Cloudflare Named Tunnel requires a fixed local port` | `portal.localPort` 设成与 Cloudflare Origin Service 一致的端口 |
| `Cloudflare Named Tunnel token is missing` / `Cloudflare rejected the Tunnel token` | 设置页保存正确的 Tunnel token（在 Zero Trust 面板重新复制） |
| `The connector registered, but the public hostname did not reach the MCP server: HTTP 4xx/5xx` | Public Hostname 或 Origin Service 配错；确认服务是 `http://127.0.0.1:<localPort>`，主机名与 `cloudflareDomain` 一致 |
| `Local port is already in use` (`EADDRINUSE`) | 换 `portal.localPort`，或结束占用端口的进程 |
| `Set portal.customTunnelCommand, or portal.customTunnelUrl for attach mode` | 自定义提供方至少要有命令或固定 URL |
| `The custom tunnel did not become ready within 30000ms` | 输出里没匹配到 URL / readyPattern。看日志里 `[custom:out]` 行，调整 `customTunnelUrlPattern`；或加大 `customTunnelTimeoutMs` |
| `run_command` 里 `ls -la` 报错 | Windows 默认 shell 是 PowerShell，`ls` 是 `Get-ChildItem` 的别名，不认 `-la`。用 PowerShell 语法，或 `shell: "bash"`（Git Bash） |
| 命令里用到的别名/函数/conda 环境找不到 | PowerShell 以 `-NoProfile` 启动。显式激活（如 `conda activate` 前先 `& conda shell.powershell hook`）或改用完整路径 |
| `Path escapes workspace` | `cwd` 或文件路径跳出了工作区 |
| `Background command limit reached (4)` | 先 `stop_command` 或等已有后台任务结束 |
| `truncated_before: true` | 要读的偏移已被 200k 环形缓冲区淘汰，去 `log_file` 里看完整输出 |
| 切换档案后地址没变 | 隧道只在启动时读配置，执行 **Portal：重启** |
| 提示词模板复制后 `{url}` 没被替换 | 快速隧道未运行时无法预测 URL，先启动；确认用的是单层花括号 `{url}` |

---

## 16. 从源码构建与调试

```bash
cd vscode-extension
npm install
npm run build        # esbuild → dist/extension.js（含 sourcemap）
npm run typecheck    # tsc --noEmit
npm run package      # 生成 portal-<版本>.vsix（vsce package --no-dependencies）
npm run watch        # 开发时持续构建
```

调试：仓库没有附带 `.vscode/launch.json`，可以自己建一个最小配置，然后 `F5` 启动扩展开发宿主：

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

源码结构速览（`src/`）：

| 文件 | 职责 |
| --- | --- |
| `extension.ts` | 入口：注册命令、挂载 UI、自动启动 |
| `session-hub.ts` | 每个 MCP 会话一个 `BridgeManager`，可并行 |
| `bridge-manager.ts` | 一次会话的生命周期：起 HTTP 服务 → 起隧道 → 统计与活动流 |
| `mcp-server.ts` | 手写的 MCP Streamable HTTP（JSON-RPC）服务，含默认 Agent 提示词 |
| `tunnel.ts` | ngrok / cloudflared quick / named / custom 的启动、就绪判定、进程清理 |
| `tools/` | 5 个工具的实现、进程 spawn、后台任务注册表 |
| `files/` | HTTP 文件 API、路径安全（工作区围栏 + 拒绝列表）、zip、WSL IO |
| `config.ts` · `profiles.ts` | 设置读取、档案/会话叠加逻辑 |
| `settings-page.ts` · `sidebar/panel.ts` · `status-bar.ts` · `agent-terminal.ts` | UI |
| `error-doctor.ts` | 已知错误 → 修复建议 |
| `nls.ts` · `package.nls*.json` | 中英文文案 |

---

## 17. 常见问题

**为什么没有 `read_file` / `write_file` 工具？**
设计取舍：工具面越小，Agent 越不容易误用，服务端也越简单。读文件用 `run_command`（`Get-Content`、`type`、`cat`）或文件 API 的 `GET`；写文件用文件 API 的 `PUT`（原子、带 SHA-256 校验），或 shell 重定向。

**AI 怎么知道文件 API 地址？**
`initialize` 返回的 instructions 末尾附了地址；调用 `file_transfer_info` 也会返回完整端点表和示例。

**能同时在同一个文件夹上跑 Portal Client（桌面版）和这个扩展吗？**
不建议——它们是同一套 MCP 契约的两种形态，同一时刻跑一个即可。

**URL 会变吗？**
ngrok 预留域名、Cloudflare 命名隧道、自定义固定 URL：只要路由令牌不变就不变。Cloudflare 快速隧道：每次启动都变。

**Portal 停止后后台任务还在吗？**
不在。停止 / 重启 / 重载窗口都会终止所有后台任务。

**能在 macOS / Linux 上用吗？**
代码里有非 Windows 分支（默认 shell `sh`、无自动安装），但作者只在 Windows 上测试过。

**多个 VS Code 窗口会互相干扰吗？**
每个窗口是独立的扩展实例。用 **连接配置档案** 给每个窗口分配不同的域名/账号；档案选择保存在各自工作区。

**`.portal/` 目录是什么？**
后台任务日志（`.portal/logs/*.log`）。放心删除；建议加入 `.gitignore`（本仓库已加）。

**MCP 协议版本？**
服务端报告 `2024-11-05`；客户端用更新的协议版本发起 `initialize` 也能协商成功（Portal 不做严格校验）。

---

*本文档随 Portal 扩展 1.1.0 编写；行为以源码为准。*
