# Portal

![Portal](resources/portal-logo.png)

**[English](README.md)** · **[简体中文](README.zh-CN.md)**

Portal 是一个 VS Code 扩展，把当前工作区暴露成 **公开 MCP 端点**。刻意做得很小：**只有命令执行和文件传输**。

任意 MCP 客户端（Claude、ChatGPT、Cursor、自写 Agent、`curl`）都可以通过隧道连到你的机器：跑 shell、搬文件。

## 1.0.2 新功能

- **提示词模板** —— 预先写好带链接的提示词：文本里用 `{url}` 作占位符，复制时自动替换为当前的公开 MCP 地址。在设置页“提示词”区管理，在侧边栏快捷条一键复制，或运行 **Portal：复制提示词模板**。固定主机名的提供方（ngrok 预留 / CF 命名隧道 / 自定义挂接）在未启动时也能预测出地址。
- **错误医生（Error doctor）** —— 启动与崩溃输出会被扫描识别已知故障（如 ngrok `ERR_NGROK_334`「端点已在线」、authtoken 问题、Cloudflare Token 被拒、本地端口被占、可执行文件缺失）。Portal 会在侧边栏和设置页显示「发生了什么 + 怎么修」卡片，每个 `ERR_NGROK_*` 错误码都附带官方错误页链接。
- **侧边栏 Logo 图标** —— 活动栏图标换成 Portal 的 Logo 标识（跟随主题着色）。
- **文件 API 健壮性修复** —— `?glob=` 列表不再可能卡死整个服务器：WSL 递归列表在遍历时即剪枝 `node_modules`/`.git`/隐藏目录，并加上超时与条目上限；glob 匹配器重写为线性时间正则（标准 `*` / `**` 语义），修复某些模式组合下回溯死循环导致请求永挂的问题。

## 你会得到什么

| 面 | 作用 |
| --- | --- |
| MCP Streamable HTTP | `https://<隧道>/mcp/<令牌>` |
| 文件 HTTP API | `https://<隧道>/files/<令牌>/…`（同一令牌） |
| 侧边栏 + 设置 | 启停、复制 URL、隧道健康检查 |
| Portal Agent 终端 | 可选，实时镜像 `run_command` 的输入输出 |

## MCP 工具（一共 5 个）

| 工具 | 作用 |
| --- | --- |
| `run_command` | 前台命令。默认超时 **120 秒**（最长 600 秒）。可用 `command` + `shell`，或不需要 shell 语法时用 `executable` + `args`（更安全）。 |
| `start_command` | 启动长驻进程，返回 `command_id` 与 PID。最多同时 4 个。 |
| `read_command` | 按偏移增量读 stdout/stderr。不传 `command_id` 则列出仍保留的任务。完成后记录保留 10 分钟。 |
| `stop_command` | 停止后台任务及其进程树（`force` 跳过 2 秒优雅退出）。 |
| `file_transfer_info` | 返回文件 API 的公开基址、大小上限和 curl 示例。 |

**Shell：** 本地 Windows 文件夹默认 `powershell`，另有 `pwsh`、`cmd`、`bash` / `sh`（检测到 Git Bash 时）。会自动配置 UTF-8。

**WSL：** 若窗口打开的是 WSL 文件夹，Portal 仍跑在 Windows（隧道继续用 Windows 上的 ngrok/cloudflared）。默认命令和 HTTP 文件 API 都经 `wsl.exe` 进发行版。不要把 `/home/...` 当成 Windows 盘上的路径。

**会话：** 复用 `initialize` 返回的 `Mcp-Session-Id`。丢失或被拒就重新 initialize，不要自己编 ID。

**没有** `read_file` / `write_file` / `edit_file` / `list_*` / `search_files`。读写请走 shell 或下面的 HTTP 文件接口。

## 文件传输（双向 HTTP）

与 MCP 同隧道、同令牌。默认单次最大 **64 MiB**（`portal.maxTransferBytes`）。上传为原子替换。下载支持 `Range`，并返回 SHA-256。

```
GET    {base}?op=info              能力信息 + 工作区
GET    {base}?glob=**/*            列出文件
GET    {base}/<relpath>            下载
HEAD   {base}/<relpath>            元数据
PUT    {base}/<relpath>            上传
DELETE {base}/<relpath>            删除
POST   {base}?op=pack              打包 zip，JSON { "paths": ["src"] }
POST   {base}?op=unpack&dest=.     解包（请求体为 zip）
```

免费 ngrok 域名需要请求头 `ngrok-skip-browser-warning: 1`。

```bash
# 下载
curl -fsSL -H "ngrok-skip-browser-warning: 1" \
  "$BASE/README.md" -o README.md

# 上传
curl -fsSL -H "ngrok-skip-browser-warning: 1" \
  -T ./photo.png "$BASE/incoming/photo.png"

# 打包目录
curl -fsSL -H "ngrok-skip-browser-warning: 1" \
  -H "Content-Type: application/json" \
  -d '{"paths":["src"]}' "$BASE?op=pack" -o src.zip
```

## 隧道提供方

| 提供方 | URL | 说明 |
| --- | --- | --- |
| `cloudflare-quick`（默认） | 每次启动新的随机 `trycloudflare.com` | 上手快，地址不固定 |
| `cloudflare-named` | 固定主机名 | 需要安全保存的 Tunnel Token、公开主机名、**固定本地端口** |
| `ngrok-reserved` | 预留域名（如 `*.ngrok-free.dev`） | 地址稳定 |
| `custom` | 自定义命令或已有 URL | 占位符：`{{port}}` `{{token}}` `{{workspace}}`。命令留空且设置 `customTunnelUrl` = 接入模式 |

路由令牌是路径上的密钥。MCP 挂在 `/mcp/<token>`。`portal.routeToken` 留空则启动时自动生成。

## 命令面板

- **Portal：启动 / 停止**
- **Portal：复制 URL**
- **Portal：复制提示词模板**
- **Portal：检查隧道**
- **Portal：设置**
- **Portal：安装 cloudflared** / **安装/升级 ngrok**
- **Portal：显示日志** / **显示 Agent 终端**

常用设置：`portal.startOnActivation`（默认开）、`portal.showCommandsInTerminal`、`portal.localPort`（`0` 自动分配；Cloudflare 命名隧道除外）。

## 构建

需要 Node 18+，VS Code `^1.95.0`。

```bash
npm install
npm run build      # esbuild → dist/extension.js
npm run typecheck
npm run package    # 打 .vsix（不打包 node_modules）
```

安装打好的 VSIX，或在桌面版 VS Code 宿主里运行本扩展（`extensionKind`：`ui` + `workspace`）。

## 许可证

MIT
