# Portal 文件工具与传输改造记录

## 任务概况
本任务仅针对本仓库的 **VS Code 扩展**，与其他业务项目无关。目标是修复文件传输可靠性问题，并增加原生 MCP 文件工具、网络中断后的上传恢复及真实范围读取。

用户授权将本次两阶段改动提交 GitHub 并创建面向 `main` 的 PR。工作分支：`feat/reliable-mcp-files`。按用户要求不编译、不构建、不运行验收、不重启现有服务。

## 当前状态
源码与双语文档已提交并推送到 `feat/reliable-mcp-files`，已创建草稿 PR [#1](https://github.com/s3hq4y/portal/pull/1)，目标为 `main`，未合并。静态语法解析及 Git 差异/哈希核对通过，仍待维护者运行验收。

## 第一阶段：可靠性与安全
- 唯一临时文件及条件发布；HTTP PUT 的 If-Match / If-None-Match 支持。
- WSL 由直接截断目标改为临时文件写完后发布。
- 中文文件名响应头、统一 CORS、请求ID、阶段/完成/取消日志及协作式deadline。
- 路径/链接/特殊文件限制，ZIP解压体积与条目、CRC及结构检查；HTTP采用受限异步ZIP路径。
- HEAD元数据路径、Range错误语义、列表截断标记及无正则回溯的glob匹配。

## 第二阶段：原生文件能力与恢复
- 新增 `read_file`、`write_file`、`apply_patch`、`list_files`。
- 文本分页不拆UTF-8字符，返回全文SHA256；后续页可按hash校验。新建不需hash，覆盖/补丁必须提供当前全文hash。
- 精确唯一匹配补丁，保留原换行约定及未修改的BOM。目录单层分页，返回cursor，不承诺快照。
- 新增 `begin_upload`、`upload_chunk`、`upload_status`、`commit_upload`、`cancel_upload`。
- 每块128 KiB，整文件最多min(maxTransferBytes,64 MiB)，最多4会话/回执，固定30分钟有效；同块相同内容可重试，提交验证全文hash，成功提交重试仅返回原回执。
- HTTP/MCP共用路径检查、写锁及本地发布原语，WSL提交前也核对预期SHA256。
- Windows/WSL真实单Range读取，最多4 MiB，只读取对应字节；返回片段hash及弱ETag，不冒充全文hash。
- 工具注册、初始化能力信息、工具说明、活动日志内容脱敏及双语使用文档同步更新。

## 文档入口
- [English file tools](vscode-extension/FILE-TOOLS.md)
- [中文文件工具](vscode-extension/FILE-TOOLS.zh-CN.md)

## 验证与交接
- 使用Babel parser进行TypeScript语法解析，无编译输出；核对工具注册、共享发布调用和日志脱敏位置。
- 写回前原文件SHA256校验，写回后SHA256一致；`git diff --check`通过。
- **未执行编译、类型检查、构建、打包或运行测试，也未安装/重启扩展。** 当前运行服务不会因源码写回自动更新。
- 提交前仅暂存明确的项目源码和文档，不包含凭证、隧道令牌、代理脚本、临时传输数据或依赖目录。
- 发布前由维护者自行构建，并在独立Windows/WSL工作区验收文本分页、补丁冲突、上传重试/过期、Range、ZIP、取消与关闭。

## 明确边界
- 历史偶发超时没有在本轮复现，不能把代码风险修复等同于已定位唯一根因。
- 原生上传恢复仅跨网络请求，不跨Portal进程重启；成功回执在取消/过期后不再保留。强制崩溃可能残留OS临时目录。
- 文件写锁不是对外部编辑器的OS级CAS；检查与发布之间仍存在外部进程竞态。配置根被信任。
- Range片段hash不是全文hash；多请求不是一致快照，If-Range保守回退完整200；完整GET的全文哈希成本仍保留。
- ZIP逐文件发布而非整包事务；异步压缩仍有受限CPU和内存开销。
- 取消不能撤销已经完成的文件发布，也不能中断所有内核操作。超时后应查询回执或目标hash。
- 独立桌面 `client/` 的复制实现未迁移，本次README和扩展文档明确能力差异。

## GitHub交接
- 功能提交：`7209f795d1bfc390cd93ef4694537349e70a441d`（feat: add reliable MCP file tools and bounded transfers）。
- PR：https://github.com/s3hq4y/portal/pull/1 ，草稿状态，面向main，包含两阶段改动。
- 本文档随后单独提交以记录已创建PR的实际状态；不重写功能提交，不force-push，不合并主分支。
- 构建/运行验证仍未执行；请维护者验证后将PR转为Ready for review并按仓库流程合并。
