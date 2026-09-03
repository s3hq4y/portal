# Portal Client

![Portal Client](resources/portal-logo.png)

**[简体中文](README.md)** · **[English](README.en.md)**

Portal Client 是一个独立的 **Windows 桌面应用**（Electron + Fluent/Win10 扁平风格 UI），把本地文件夹暴露成**公开 MCP（Model Context Protocol）端点**——不需要 VS Code。它是 Portal 扩展的独立移植，还额外支持**原生浏览器窗口停靠**。

选一个文件夹 → Portal 在 `127.0.0.1` 上跑一个极简 MCP 服务器（命令执行 + 文件传输）→ 通过隧道（ngrok / Cloudflare / 自定义命令）发布成公网 URL（形如 `https://…/mcp/<令牌>`）→ 任意 MCP 客户端（Claude、Cursor 等）即可接入。

## 功能

### MCP（与扩展同一套协议，恰好 5 个工具）

| 工具 | 用途 |
| --- | --- |
| `run_command` | 前台命令。默认超时 **120s**（上限 600s）。可用 `command` + `shell`，或 `executable` + `args`。 |
| `start_command` | 启动长驻进程，返回 `command_id` 与 PID，最多 4 个并发任务。 |
| `read_command` | 按偏移增量读取 stdout/stderr；省略 `command_id` 则列出保留中的任务。 |
| `stop_command` | 停止后台任务及其进程树（`force` 跳过 2s 优雅期）。 |
| `file_transfer_info` | 返回文件 API 的公开基址、大小上限和 curl 示例。 |

### 文件 HTTP API

挂在 `/files/<令牌>` 下，与 MCP 同隧道同令牌：下载 / 上传 / 删除 / 列表 / 打包 / 解包，支持 `Range`、SHA-256、ETag、路径越界拦截 + 拒绝名单、原子写入，默认上限 **64 MiB**。

### 隧道

- `ngrok-reserved`（预留域名，可选 `--pooling-enabled` 负载均衡）
- `cloudflare-quick` / `cloudflare-named`（令牌存于操作系统加密的 `safeStorage`）
- `custom`（任意命令，支持 `{{port}}` / `{{token}}` / `{{workspace}}` 占位符；或直接挂接到已存在的公网 URL）

隧道二进制（ngrok / cloudflared）自动探测，也可在应用内通过 winget 一键安装。

### 浏览器停靠（Windows 专属）

- **捕获已打开的浏览器窗口**（Edge / Chrome / Firefox / Brave / Vivaldi / Opera）：点「抓取」再点屏幕上任意浏览器窗口，或从列表里直接停靠。窗口通过 Win32 `SetParent` 原生挂载进应用，**窗口本身原封不动**——分离后它回到桌面，而不是被关闭。
- **右侧停靠面板**：独立于左侧功能页的浏览器面板，竖直方向从标题栏延伸到底部，宽度可拖分隔条调整（自动记忆），总被主窗口包围。
- **把手条**：停靠窗口上方有标题条（窗口标题 + ✕ 按钮），**拖动即可把窗口拽出还原**，点 ✕ 直接还原到停靠前的位置和尺寸。
- **内置浏览器兜底**：内置 Chromium（`WebContentsView`），无需外部浏览器也能在应用内浏览。

### 其它

- **Agent 终端**：前台命令的输入输出实时镜像到只读终端视图；后台任务写入 `.portal/logs` 下的独立日志（10 分钟后清理）。
- **活动流 + 会话统计 + 日志 + 本地化错误诊断**（中文 / English）。
- **提示词模板 + Agent 指令**编辑器（复制链接时自动填入 `{url}`）。
- 单实例、系统托盘、最小化到托盘、可选开机自启。
- 支持 **WSL 工作区**（选择 `\\wsl.localhost\…` 目录，命令跑进发行版，隧道仍在 Windows）。

## 系统要求

- Windows 10 / 11（x64）
- Node.js ≥ 20（开发/构建时需要）
- 隧道二进制（可选，应用内可装）：**ngrok**（`ngrok-reserved` 需先 `ngrok config` 认证）· **cloudflared**

## 运行（开发）

```bash
npm install
npm run dev        # 构建并启动
```

其它脚本：

```bash
npm run build      # tsc + 拷贝资源 → dist/
npm run typecheck  # 仅类型检查
npm run dist       # electron-builder → NSIS 安装包（release/）
```

## 使用

1. 打开应用 → **概览**页点「选择…」挑一个文件夹。
2. 点「启动」→ 隧道建立后复制公开 URL（形如 `https://…/mcp/<令牌>`）。
3. 把 URL 粘给任意 MCP 客户端（Claude / Cursor / 自写 Agent）。
4. （可选）点左侧「浏览器」开关，输入网址用内置浏览器，或「抓取」一个已打开的浏览器窗口停靠到右侧。

## 项目结构

```
client/
  src/shared/          类型、i18n（EN/ZH）、IPC 契约
  src/main/            主进程：桥接、MCP 服务器、隧道、工具、文件 API、浏览器捕获/内嵌
  src/main/browser/    win32.ts（koffi FFI）、capture-manager.ts、embed-manager.ts
  src/preload.ts       contextBridge API
  src/renderer/        Fluent UI（index.html、styles.css、app.js）
  resources/           图标与徽标
  scripts/             构建资源拷贝
```

## 注意事项

- MCP 服务器只绑定 **127.0.0.1**，隧道是唯一的公网入口。
- 路由令牌是嵌在公网 URL 里的 32 位十六进制密钥——**当作密码保管**。
- 后台任务日志 10 分钟后清理；后台任务最多同时 4 个。
- 浏览器窗口捕获为 Windows 专属功能（Win32）；内置浏览器跨平台可用（但目前应用整体只面向 Windows 发布）。

## 许可证

GPL-3.0-or-later —— 详见 [LICENSE](LICENSE)。
