# Native file tools and reliable binary transfer

This document applies to the **VS Code extension**. The standalone desktop `client/` has a separate implementation and has not been migrated by this change.

## Choosing a transport

- Source files: `read_file`, `write_file`, `apply_patch`, `list_files`.
- Binary files or writes larger than 128 KiB: `begin_upload`, `upload_chunk`, `upload_status`, `commit_upload`, `cancel_upload`.
- Existing clients may continue using HTTP. Native tools and HTTP share path validation, per-target locks and local publication primitives; WSL uses the same checked I/O adapter.
- No new command-execution permissions are introduced. Existing commands can still act outside the file API's sandbox; do not treat a command-capable endpoint as a file-only sandbox.

## Text tools

| Tool | Inputs | Behavior |
|---|---|---|
| `read_file` | `path`, optional `offset`, `max_bytes`, `expected_sha256` | UTF-8 file up to 1 MiB. Byte offsets respect UTF-8 boundaries. Returns `content`, full-file `sha256`, `next_offset`, `eof`, encoding/BOM/newline metadata. |
| `write_file` | `path`, `content`, optional `expected_sha256` | Literal UTF-8 payload up to 128 KiB. Without a hash, create-only. With a full-file hash, conditional replacement. |
| `apply_patch` | `path`, `old_text`, `new_text`, `expected_sha256` | Exactly one occurrence; empty/ambiguous matches fail. Retains the original newline convention and untouched BOM. Existing and resulting files are limited to 1 MiB. |
| `list_files` | optional `path` (default `.`), `page_size` (1–200), `cursor` | One directory per call, sorted by name. Explicitly descend into child directories. Hidden/dependency/sensitive entries are omitted. |

Read pages default to 32 KiB, maximum 64 KiB. Escaped JSON size can shorten a page further. Always use the returned `next_offset`; do not compute it from string length. Send the first page's `sha256` as `expected_sha256` on later pages: a changing file fails rather than silently mixing versions. Each page rereads the bounded file to validate its full hash.

Directory cursors are not snapshots. Concurrent directory changes can change later pages. A directory with more than 10,000 scanned entries is rejected; narrow the path or use a command/HTTP listing. Returned counts never imply an entire recursive workspace scan.

### Safe patch example

1. `read_file({"path":"src/example.ts"})` and retain its full-file SHA256.
2. `apply_patch({"path":"src/example.ts","old_text":"const enabled = false;","new_text":"const enabled = true;","expected_sha256":"<64 hex characters>"})`.
3. On conflict, reread and merge. Never fall back to an unconditional overwrite.

`write_file` writes the supplied content literally; use `apply_patch` when preserving existing BOM/newlines is important. Text tools reject binary/NUL-containing or invalid UTF-8 files. Sensitive paths and links under the configured root remain blocked.

## Retry-safe chunk upload protocol

1. Compute the source file's byte length and complete SHA256.
2. Call `begin_upload` with `path`, `total_bytes`, `sha256`. For an overwrite, include the current target's full-file `expected_sha256`; omitting it means create-only.
3. Read `upload_id`, `chunk_bytes` and `chunk_count`. Send `upload_chunk` with zero-based `index` and standard padded `data_base64`. Each chunk is exactly 128 KiB, except the last.
4. After an interrupted request, call `upload_status`. Send only `missing_chunks`. Identical chunk retries return an acknowledgement; changing an acknowledged chunk fails.
5. `commit_upload` validates all chunks and the assembled SHA256, then conditionally publishes the target. A repeated successful commit returns the stored receipt without rewriting the target.
6. `cancel_upload` discards an incomplete upload or releases a completed receipt. It never deletes or rolls back the committed target.

### Limits and lifetime

- Maximum file size: `min(maxTransferBytes, 64 MiB)`.
- At most four active sessions/retained receipts per executor. Release completed receipts to free slots.
- Fixed 30-minute session lifetime. Explicit cancellation, expiration and normal executor shutdown remove temporary chunks on a best-effort basis.
- Session metadata exists **only in the running process**. Network interruption is resumable; a Portal restart is not. After restart, first inspect the target hash before starting over.
- Temporary chunks live in randomly named OS temporary directories, not in the workspace. A hard process crash can leave orphan temporary folders; automatic cross-process orphan discovery is not implemented.
- Each native file call has a 60-second cooperative deadline. Assembly and publication remain bounded-buffer operations; they are not an unlimited streaming upload service.
- A timeout at the instant of filesystem publication may have an uncertain result. Query status/target hash; do not assume a timed-out write failed.

## HTTP compatibility

- Full GET retains the existing strong `ETag`/`X-File-Sha256` contract. Existing large local GETs still perform a complete hash before streaming; a cache/snapshot service is not introduced here.
- HEAD is metadata-only and does not read the whole file or return a full-file hash.
- A valid single Range up to 4 MiB reads only that byte window, also on Windows-hosted WSL (`dd` byte offset/count). The response includes `X-Range-Sha256` for the **returned bytes**, plus a **weak metadata ETag**. Neither is a full-file overwrite precondition.
- If-Range conservatively falls back to full `200`; unsatisfiable valid ranges return `416`. Oversized ranges return `413`; request smaller pieces. Multiple/malformed ranges may be ignored and served as full `200`.
- Range metadata checks detect ordinary concurrent changes but do not promise a multi-request snapshot, particularly with second-resolution WSL timestamps. Verify a trusted full-file hash after assembling multiple ranges.
- HTTP PUT supports an exact quoted strong `If-Match` SHA256 (or `*`) and `If-None-Match: *`. Without a condition it retains its old overwrite behavior. New native writes are safer by default: no hash means create-only.
- `X-File-Path` is percent-encoded UTF-8; `Content-Disposition` includes RFC 5987 `filename*`.
- Request logs contain IDs, phases and durations. Native file content, replacement text and base64 chunks are redacted from activity logs.

## Safety boundaries

Publication is atomic per file when supported by the filesystem; ZIP extraction is not a whole-archive transaction. Per-path locks coordinate Portal operations, not arbitrary external editors. A local malicious process swapping directories can race filesystem checks; the configured root is trusted. No-clobber hard-link publication fails on unsupported filesystems instead of silently weakening its guarantee.

ZIP HTTP processing uses bounded asynchronous compression/decompression, entry and expanded-size limits, CRC/size/header checks and target validation. Some bounded CPU/memory work remains. Cooperative cancellation cannot undo an already completed rename/link or cancel every kernel operation.

## Validation status

This change was reviewed with static source parsing and Git diff/hash checks only. At the user's request, no build, packaging, typecheck, runtime tests, extension installation or service restart was performed. Before release, run Windows and WSL acceptance checks for text pagination, UTF-8/BOM patches, conflicts, HTTP/native lock contention, upload retry/expiry, byte ranges, malformed archives, cancellation and shutdown. Do not mistake these recommendations for completed tests.
