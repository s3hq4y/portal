# 原生文件工具与可靠二进制传输

本文适用于 **VS Code 扩展**。独立桌面 `client/` 有一套复制实现，本次没有移植，其工具能力暂时不同。

## 如何选择

- 源码读写：`read_file`、`write_file`、`apply_patch`、`list_files`。
- 二进制或超过128 KiB的写入：`begin_upload`、`upload_chunk`、`upload_status`、`commit_upload`、`cancel_upload`。
- 原HTTP客户端仍可使用。HTTP与MCP共用路径策略、目标写锁及本地文件发布原语；WSL使用同一个检查过路径的适配器。
- 命令工具仍是用户授权的命令能力，不等同于文件API沙箱。本次不扩大命令权限。

## 文本工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `read_file` | `path`；可选`offset`、`max_bytes`、`expected_sha256` | UTF-8文件不超过1 MiB；返回正文、全文SHA256、下一字节偏移、eof、BOM及换行信息。 |
| `write_file` | `path`、`content`；可选`expected_sha256` | 一次最多128 KiB。无哈希只允许新建；覆盖必须提供原文件全文哈希。 |
| `apply_patch` | `path`、`old_text`、`new_text`、`expected_sha256` | 只替换唯一精确匹配，找不到或多处匹配则失败；保留换行约定及未修改的BOM。原文件及结果不超过1 MiB。 |
| `list_files` | 可选`path`（默认`.`）、`page_size`（1–200）、`cursor` | 按名称排序，单层分页；显式进入子目录，不做无限递归。隐藏、依赖及敏感目录省略。 |

读取默认每页32 KiB，最多64 KiB，JSON转义较大时会进一步缩短。必须使用返回的`next_offset`，不能用JavaScript字符串长度推算字节位置。后续页带首个响应的`expected_sha256`，文件变动时拒绝混合版本；每页会重新读取有界文件并验证全文哈希。

目录分页不是快照，目录被并发修改可能影响后续结果。单层扫描超过10000条时拒绝，应缩小路径或使用命令/HTTP列表；不要把一页结果当作整个项目。

`write_file`按给定内容写入UTF-8；需要保留原BOM/换行时使用`apply_patch`。文本工具拒绝无效UTF-8、NUL二进制、敏感路径及工作区根下的链接。

### 修改示例

1. `read_file({"path":"src/example.ts"})`，保存全文SHA256。
2. `apply_patch({"path":"src/example.ts","old_text":"const enabled = false;","new_text":"const enabled = true;","expected_sha256":"<64位十六进制>"})`。
3. 冲突时重新读取并合并，不要退化成无条件覆盖。

## 可重试分块上传

1. 本地计算源文件总字节数和全文SHA256。
2. `begin_upload`传`path`、`total_bytes`、`sha256`。覆盖时另传目标当前全文`expected_sha256`；不传只允许新建。
3. 使用返回的`upload_id`、`chunk_bytes`、`chunk_count`。`upload_chunk`传零基`index`与标准带填充的`data_base64`，每块128 KiB，最后一块可较小。
4. 请求中断后调用`upload_status`，只补`missing_chunks`。同一索引/内容重试安全，不同内容覆盖已确认块会被拒绝。
5. `commit_upload`验证所有块及全文哈希后条件发布。成功提交的重试只返回原回执，不再次覆盖目标。
6. `cancel_upload`删除未完成上传或释放成功回执/配额，不删除、回滚已提交的目标文件。

### 限制

- 文件上限`min(maxTransferBytes,64 MiB)`。
- 每个执行器最多4个会话或成功回执，完成后可cancel释放名额。
- 固定30分钟过期。取消、过期与正常关闭尽力清理临时块。
- 会话元数据仅存在当前进程；**支持网络中断重试，不支持Portal重启后续传**。重启后先检查目标哈希再重新上传。
- 块保存在随机OS临时目录，不进入用户项目；强制崩溃可能残留目录，跨进程孤儿清理未实现。
- 每次原生文件调用有60秒协作式deadline。合并/提交仍是有界缓冲操作，不是无限流式服务。
- 若超时恰逢底层文件发布，结果可能不确定，应查询status/目标哈希，不可假设失败后盲目重试。

## HTTP变化

- 完整GET保留强ETag及`X-File-Sha256`。本地完整GET仍先读取全文计算哈希，再发送文件；本轮不引入哈希缓存/快照服务。
- HEAD只读元数据，不再返回全文哈希。
- 单Range最多4 MiB，真正读取相应字节窗口；WSL使用`dd`的字节offset/count。`X-Range-Sha256`只校验返回片段，ETag为弱元数据ETag，**不可作为覆盖文件的全文哈希**。
- `If-Range`保守回退完整200；有效但不可满足的Range返回416，过大范围返回413。多段或格式错误Range可被忽略，回退完整200。
- Range检查可发现常见并发修改，但多次请求不是同一文件快照，WSL时间戳精度尤其有限。拼接后应校验可信的全文哈希。
- PUT支持单个带引号强哈希`If-Match`或`*`，及`If-None-Match: *`。无条件HTTP PUT保留旧覆盖行为；原生写入默认更严格，无哈希只新建。
- `X-File-Path`是percent-encoded UTF-8；下载文件名使用标准`filename*`。
- 日志记录请求ID、阶段及耗时；原生文件正文、替换文本和base64块不写入活动日志。

## 保证边界

原子发布以单文件为单位，ZIP不是整包事务；目标写锁协调Portal操作，不能锁住任意外部编辑器。配置根被信任，恶意本地进程替换目录仍可能与路径检查竞态。不支持硬链接的文件系统会拒绝no-clobber发布，不静默降级。

HTTP ZIP使用有界异步压缩/解压、展开总量/条数限制及CRC、长度、本地头/中央目录、目标路径检查。仍有有界CPU和内存开销；取消不能撤销已经完成的rename/link，也不能中断所有内核操作。

## 检查状态

仅完成静态源码语法解析、差异及哈希核对。按用户要求未编译、打包、类型检查、运行测试、安装或重启扩展。发布前建议在独立Windows和WSL目录验收文本分页、UTF-8/BOM补丁、并发冲突、HTTP/MCP同目标写锁、上传重试/过期、Range、损坏ZIP、取消与关闭。以上建议不是已执行测试。
