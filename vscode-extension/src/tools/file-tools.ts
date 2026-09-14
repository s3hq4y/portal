/** Native file tools: bounded text access and retry-safe binary uploads. */
import { ToolContext, ToolModule, text } from "./types";
import { FileService, TEXT_FILE_LIMIT, TEXT_PAGE_LIMIT } from "../files/service";
import { fileError } from "../files/file-ops";

const stringField = (args: any, key: string, max: number, empty = false): string => {
  if (typeof args?.[key] !== "string" || (!empty && !args[key]) || Buffer.byteLength(args[key], "utf8") > max) throw fileError(400, `Invalid ${key}`);
  return args[key];
};
const hashField = (args: any, key: string, required = false): string | undefined => {
  if (args?.[key] === undefined && !required) return undefined;
  const value = stringField(args, key, 64);
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw fileError(400, `${key} must be a complete SHA256`);
  return value.toLowerCase();
};
const integer = (value: unknown, min: number, max: number, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw fileError(400, "Invalid integer argument");
  return value;
};
const pathArg = (args: any) => stringField(args, "path", 4096);
const pathSchema = { type: "string", description: "Workspace-relative path; links and sensitive paths are blocked." };
const hashSchema = { type: "string", pattern: "^[a-fA-F0-9]{64}$", description: "Full-file SHA256 from read_file or a complete HTTP GET, not a range hash." };
const idSchema = { type: "string", description: "Upload ID returned by begin_upload." };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

async function execute(ctx: ToolContext, action: (service: FileService, signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  ctx.fileSignal?.addEventListener("abort", abort, { once: true });
  if (ctx.fileSignal?.aborted) controller.abort();
  const timer = setTimeout(abort, 60_000);
  try {
    const service = new FileService({ workspaceRoot: ctx.workspaceRoot, wslDistro: ctx.wslDistro,
      posixRoot: ctx.posixRoot, maxTransferBytes: ctx.maxTransferBytes, signal: controller.signal });
    return text(JSON.stringify(await action(service, controller.signal)));
  } finally { clearTimeout(timer); ctx.fileSignal?.removeEventListener("abort", abort); }
}
function uploads(ctx: ToolContext) {
  if (!ctx.uploadSessions) throw fileError(503, "Upload sessions are not available");
  return ctx.uploadSessions;
}
const uploadId = (args: any) => {
  const id = stringField(args, "upload_id", 64);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw fileError(400, "Invalid upload ID");
  return id;
};
export const fileTools: ToolModule[] = [
  {
    name: "read_file", description: "Read a UTF-8 file up to 1 MiB in bounded pages. Returns full-file SHA256 and next_offset. Pass that SHA256 on subsequent pages to detect changes. Use HTTP for larger or binary files.",
    inputSchema: schema({ path: pathSchema, offset: { type: "integer", minimum: 0 }, max_bytes: { type: "integer", minimum: 4, maximum: TEXT_PAGE_LIMIT }, expected_sha256: hashSchema }, ["path"]),
    handle: (ctx, args) => execute(ctx, service => service.readText(pathArg(args), integer(args?.offset, 0, TEXT_FILE_LIMIT, 0), integer(args?.max_bytes, 4, TEXT_PAGE_LIMIT, 32768), hashField(args, "expected_sha256"))),
  },
  {
    name: "write_file", description: "Write literal UTF-8 text (at most 128 KiB per call), using atomic publication. Omit expected_sha256 ONLY to create a new file. Overwriting an existing file requires its current full-file SHA256. Use apply_patch to preserve existing BOM/newlines during small edits.",
    inputSchema: schema({ path: pathSchema, content: { type: "string" }, expected_sha256: hashSchema }, ["path", "content"]),
    handle: (ctx, args) => execute(ctx, service => service.writeBytes(pathArg(args), Buffer.from(stringField(args, "content", 128 * 1024, true), "utf8"), hashField(args, "expected_sha256"))),
  },
  {
    name: "apply_patch", description: "Replace exactly one matching text occurrence in a UTF-8 file up to 1 MiB. Requires current SHA256; preserves newline convention and untouched BOM. Ambiguous or missing matches fail, without modifying the file.",
    inputSchema: schema({ path: pathSchema, old_text: { type: "string", minLength: 1 }, new_text: { type: "string" }, expected_sha256: hashSchema }, ["path", "old_text", "new_text", "expected_sha256"]),
    handle: (ctx, args) => execute(ctx, service => service.patch(pathArg(args), stringField(args, "old_text", 128 * 1024), stringField(args, "new_text", 128 * 1024, true), hashField(args, "expected_sha256", true)!)),
  },
  {
    name: "list_files", description: "List one directory with bounded, lexicographic pagination. Hidden, sensitive and dependency directories are omitted. Descend explicitly; cursor is not a filesystem snapshot.",
    inputSchema: schema({ path: pathSchema, page_size: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string" } }, []),
    handle: (ctx, args) => execute(ctx, service => service.list(args?.path === undefined ? "." : pathArg(args), integer(args?.page_size, 1, 200, 100), args?.cursor === undefined ? undefined : stringField(args, "cursor", 8192))),
  },
  {
    name: "begin_upload", description: "Start a binary upload up to min(maxTransferBytes,64 MiB). Four concurrent sessions, 30-minute lifetime. Requires complete size/SHA256; omit expected_sha256 only for create-only. Sessions survive network retries, NOT Portal restarts.",
    inputSchema: schema({ path: pathSchema, total_bytes: { type: "integer", minimum: 0, maximum: 67108864 }, sha256: hashSchema, expected_sha256: hashSchema }, ["path", "total_bytes", "sha256"]),
    handle: (ctx, args) => execute(ctx, (_service, signal) => uploads(ctx).begin(pathArg(args), integer(args?.total_bytes, 0, 64 * 1024 * 1024), hashField(args, "sha256", true)!, hashField(args, "expected_sha256"), signal)),
  },
  {
    name: "upload_chunk", description: "Upload the requested 128 KiB chunk (last chunk may be smaller) as standard base64. Retrying the same index and bytes is safe; different bytes for an acknowledged index fail.",
    inputSchema: schema({ upload_id: idSchema, index: { type: "integer", minimum: 0 }, data_base64: { type: "string" } }, ["upload_id", "index", "data_base64"]),
    handle: (ctx, args) => execute(ctx, (_service, signal) => {
      const encoded = stringField(args, "data_base64", 174764, true);
      const data = Buffer.from(encoded, "base64");
      if (data.toString("base64") !== encoded || data.length > 128 * 1024) throw fileError(400, "Invalid or oversized standard base64 chunk");
      return uploads(ctx).chunk(uploadId(args), integer(args?.index, 0, 511), data, signal);
    }),
  },
  {
    name: "upload_status", description: "Get missing chunk indices or the completed receipt. Query after network failure before retrying or starting a new upload.",
    inputSchema: schema({ upload_id: idSchema }, ["upload_id"]),
    handle: (ctx, args) => execute(ctx, (_service, signal) => uploads(ctx).status(uploadId(args), signal)),
  },
  {
    name: "commit_upload", description: "Verify all chunks and the complete SHA256, then conditionally publish the file. Repeating a successful commit returns the original receipt without rewriting the target.",
    inputSchema: schema({ upload_id: idSchema }, ["upload_id"]),
    handle: (ctx, args) => execute(ctx, (_service, signal) => uploads(ctx).commit(uploadId(args), signal)),
  },
  {
    name: "cancel_upload", description: "Discard an incomplete upload or release a completed receipt/session slot. Never deletes or rolls back a committed target file.",
    inputSchema: schema({ upload_id: idSchema }, ["upload_id"]),
    handle: (ctx, args) => execute(ctx, (_service, signal) => uploads(ctx).cancel(uploadId(args), signal)),
  },
];
