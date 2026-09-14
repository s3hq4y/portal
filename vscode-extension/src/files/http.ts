/**
 * HTTP file-transfer API mounted at /files/<routeToken> on the same local
 * server as MCP (exposed through the same tunnel).
 *
 * Operations:
 *   GET/HEAD  ?op=info          capability + endpoint listing
 *   GET       ?glob=&path=      list files (JSON with size/mtime; SKIP_DIRS
 *                               + hidden dirs pruned, hard entry/time caps)
 *   GET/HEAD  /<relpath>        download (Range + sha256 + ETag supported)
 *   PUT       /<relpath>        upload (atomic tmp+rename, size-capped)
 *   DELETE    /<relpath>        delete
 *   POST      ?op=pack          zip the given {paths:[...]} and stream it back
 *   POST      ?op=unpack&dest=. extract a raw zip body into the workspace
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { guessContentType, isDenied, parseFilesRequest, resolveSafeLocal, normalizeRel } from "./paths";
import { unzipEntriesAsync, zipEntriesAsync, ZipEntry } from "./zip";
import { SKIP_DIRS } from "../tools/workspace";
import { WslIo } from "./wsl-io";
import { checkAborted, fileError as httpError, withFileLock, readLimitedFile, sha256File, publishLocalFile } from "./file-ops";

export interface FileHttpOptions {
  workspaceRoot: string;
  routeToken: string;
  maxBytes: number;
  filesBaseUrl?: string;
  wslDistro?: string;
  posixRoot?: string;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  onTransfer?: (info: { op: string; path: string; ok: boolean; bytes?: number; detail?: string; requestId?: string; durationMs?: number; phase?: string }) => void;
}

function wslIo(opts: FileHttpOptions): WslIo | undefined {
  if (!opts.wslDistro || !opts.posixRoot) return undefined;
  return new WslIo(opts.wslDistro, opts.posixRoot, opts.signal);
}

// Wide-open CORS (same rationale as mcp-server) incl. headers clients send
// through ngrok.
export const FILE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Content-Range, Range, If-Match, If-None-Match, mcp-session-id, ngrok-skip-browser-warning",
  "Access-Control-Expose-Headers": "Content-Length, Accept-Ranges, Content-Range, X-File-Sha256, ETag, X-File-Path, X-Range-Sha256, X-Request-Id",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const data = JSON.stringify(body);
  res.writeHead(status, { ...FILE_CORS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function text(res: http.ServerResponse, status: number, msg: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { ...FILE_CORS, "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

// Fast-path check used by the MCP server to delegate /files requests.
export function isFilesRequest(urlStr: string | undefined, token: string): boolean {
  if (!urlStr || !token) return false;
  try { return parseFilesRequest(urlStr, token) !== null; } catch { return false; }
}

// Route by method + op; errors map to 400/403/404/405/409.
export async function handleFilesHttp(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions): Promise<void> {
  // Parse is outside the try below on purpose — but a malformed URL must never
  // reject the (void-swallowed) promise and leave the request hanging.
  let parsed: { rel: string; query: URLSearchParams } | null = null;
  try { parsed = parseFilesRequest(req.url || "/", opts.routeToken); } catch { parsed = null; }
  if (!parsed) { text(res, 404, "Not Found"); return; }
  const op = (parsed.query.get("op") || "").toLowerCase();
  const method = (req.method || "GET").toUpperCase();
  const requestId = randomUUID(), started = Date.now();
  const controller = new AbortController();
  const notify = opts.onTransfer;
  let detail = "request accepted", bytes: number | undefined, operation = op || method, recorded = false;
  const safeNotify = (info: Parameters<NonNullable<FileHttpOptions["onTransfer"]>>[0]) => {
    try { notify?.(info); } catch { /* Logging must never break a transfer. */ }
  };
  const finish = (completed: boolean) => {
    if (recorded) return;
    recorded = true; clearTimeout(deadline);
    safeNotify({ op: operation, path: parsed!.rel, ok: completed && res.statusCode < 400,
      bytes: completed ? bytes : undefined, requestId, durationMs: Date.now() - started,
      phase: completed ? "finish" : "abort", detail });
  };
  const deadline = setTimeout(() => {
    detail = "File request deadline exceeded";
    json(res, 504, { ok: false, error: detail, requestId });
    controller.abort();
  }, opts.requestTimeoutMs ?? 120_000);
  res.setHeader("X-Request-Id", requestId);
  res.once("finish", () => finish(true));
  res.once("close", () => { if (!res.writableFinished) { controller.abort(); finish(false); } });
  req.once("aborted", () => { detail = "Client aborted request"; controller.abort(); });
  controller.signal.addEventListener("abort", () => {
    if (!req.complete && !req.destroyed) setImmediate(() => req.destroy());
  }, { once: true });
  opts = { ...opts, signal: controller.signal, onTransfer: (info) => {
    operation = info.op; bytes = info.bytes; detail = info.detail ?? detail;
    if (info.phase === "progress") safeNotify({ ...info, requestId, durationMs: Date.now() - started });
  } };
  safeNotify({ op: operation, path: parsed.rel, ok: true, requestId, durationMs: 0, phase: "start", detail });
  try {
    if (method === "OPTIONS") {
      res.writeHead(204, FILE_CORS);
      res.end();
      return;
    }
    if (method === "GET" && (parsed.rel === "" || op === "info")) {
      if (op === "info" || parsed.query.get("info") === "1") {
        json(res, 200, {
          ok: true,
          filesBaseUrl: opts.filesBaseUrl,
          maxBytes: opts.maxBytes,
          conditionalUpload: { ifMatch: '"<sha256>" or *', ifNoneMatch: "*" },
          headIncludesHash: false,
          requestTimeoutMs: opts.requestTimeoutMs ?? 120_000,
          workspace: opts.workspaceRoot,
          endpoints: {
            info: "GET {base}?op=info",
            list: "GET {base}?glob=**/*&path=.",
            download: "GET {base}/<relpath>  (Range supported)",
            head: "HEAD {base}/<relpath>",
            upload: "PUT {base}/<relpath>",
            delete: "DELETE {base}/<relpath>",
            pack: "POST {base}?op=pack   JSON {paths:[]}",
            unpack: "POST {base}?op=unpack&dest=.  body=zip",
          },
        });
        return;
      }
      await listDir(res, opts, parsed.query.get("path") || ".", parsed.query.get("glob") || "**/*");
      return;
    }
    if (method === "POST" && op === "pack") {
      await packOp(req, res, opts);
      return;
    }
    if (method === "POST" && op === "unpack") {
      await unpackOp(req, res, opts, parsed.query.get("dest") || ".");
      return;
    }
    if (!parsed.rel) { text(res, 400, "Missing path"); return; }
    if (isDenied(parsed.rel)) { text(res, 403, "Path is blocked"); return; }

    const abs = wslIo(opts) ? wslIo(opts)!.resolvePosix(parsed.rel) : await resolveSafeLocal(opts.workspaceRoot, parsed.rel);
    if (method === "GET" || method === "HEAD") {
      await sendFile(req, res, opts, abs, parsed.rel, method === "HEAD");
      return;
    }
    if (method === "PUT") {
      await withFileLock(opts.workspaceRoot + "/" + abs, opts.signal, () => receiveFile(req, res, opts, abs, parsed!.rel, parsed!.query.get("overwrite") !== "false"));
      return;
    }
    if (method === "DELETE") {
      await withFileLock(opts.workspaceRoot + "/" + abs, opts.signal, () => deleteFile(res, opts, abs, parsed!.rel));
      return;
    }
    text(res, 405, "Method Not Allowed");
  } catch (e: any) {
    opts.onTransfer?.({ op: method, path: parsed.rel, ok: false, detail: e?.message });
    const msg = e?.message ?? String(e);
    const status = e?.statusCode ?? (/escapes workspace|blocked/i.test(msg) ? 403 : /too large|exceeds|maxTransferBytes/i.test(msg) ? 413 : /timed out|deadline/i.test(msg) ? 504 : e?.code === "ENOENT" ? 404 : e?.code === "EEXIST" ? 409 : e?.code === "EACCES" || e?.code === "EPERM" ? 403 : 400);
    json(res, status, { ok: false, error: msg, requestId });
  }
}

// Recursive listing capped at 2000 entries; hidden, SKIP_DIRS and DENY paths
// are skipped, and the walk is bounded in time (see deadlines below).
async function listDir(res: http.ServerResponse, opts: FileHttpOptions, relDir: string, globPat: string): Promise<void> {
  const wsl = wslIo(opts);
  const matchFile = compileGlob(globPat);
  if (wsl) {
    const st = await wsl.stat(relDir || ".");
    if (!st) { json(res, 404, { ok: false, error: "Not found" }); return; }
    if (st.kind === "file") {
      const rel = normalizeRel(relDir || ".");
      json(res, 200, { ok: true, files: [{ path: rel, size: st.size, mtime: new Date(st.mtimeMs).toISOString(), kind: "file" }] });
      return;
    }
    const entries = await wsl.list(relDir || ".", true);
    let truncated = entries.length >= 100_000;
    const files: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      if (files.length >= 2000) { truncated = true; break; }
      if (e.kind !== "file") continue;
      if (isDenied(e.rel)) continue;
      const parts = e.rel.split("/");
      const parents = parts.slice(0, -1);
      // Match the local walker: skip SKIP_DIRS and any hidden directory.
      if (parents.some((seg) => SKIP_DIRS.has(seg) || seg.startsWith("."))) continue;
      if (matchFile && !matchFile(e.rel)) continue;
      files.push({
        path: e.rel,
        size: e.size,
        mtime: new Date(e.mtimeMs).toISOString(),
        kind: "file",
      });
    }
    json(res, 200, { ok: true, root: normalizeRel(relDir || "."), count: files.length, truncated, files });
    opts.onTransfer?.({ op: "LIST", path: relDir || ".", ok: true, detail: `${files.length} entries; truncated=${truncated}` });
    return;
  }
  const root = await resolveSafeLocal(opts.workspaceRoot, relDir || ".");
  const st = await fsp.stat(root).catch(() => null);
  if (!st) { json(res, 404, { ok: false, error: "Not found" }); return; }
  if (st.isFile()) {
    json(res, 200, { ok: true, files: [await statEntry(opts.workspaceRoot, root)] });
    return;
  }
  const files: Array<Record<string, unknown>> = [];
  // Wall-clock guard: same rationale as the WSL pruned find — a pathological
  // tree must not occupy the handler forever (the walk stays async, this only
  // bounds its lifetime).
  const deadline = Date.now() + 10_000;
  let truncated = false;
  const walk = async (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      checkAborted(opts.signal);
      if (files.length >= 2000 || Date.now() > deadline) { truncated = true; return; }
      const full = path.join(dir, e.name);
      const rel = path.relative(opts.workspaceRoot, full).replace(/\\/g, "/");
      if (isDenied(rel)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(full);
      } else if (e.isFile()) {
        if (matchFile && !matchFile(rel)) continue;
        files.push(await statEntry(opts.workspaceRoot, full));
      }
    }
  };
  await walk(root);
  json(res, 200, { ok: true, root: normalizeRel(relDir || "."), count: files.length, truncated, files });
  opts.onTransfer?.({ op: "LIST", path: relDir || ".", ok: true, detail: `${files.length} entries; truncated=${truncated}` });
}

async function statEntry(workspaceRoot: string, abs: string): Promise<Record<string, unknown>> {
  const st = await fsp.stat(abs);
  return {
    path: path.relative(workspaceRoot, abs).replace(/\\/g, "/"),
    size: st.size,
    mtime: st.mtime.toISOString(),
    kind: st.isDirectory() ? "dir" : "file",
  };
}

// Bounded dynamic-programming glob matcher; no regex backtracking.
// "**/" matches zero or more complete directories, "*" stays in a segment.
function compileGlob(pattern: string): ((rel: string) => boolean) | null {
  const p = pattern.replace(/\\/g, "/").trim();
  if (!p || p === "**" || p === "**/*") return null;
  if (p.length > 512) throw new Error("Glob is too complex");
  const tokens: Array<{ kind: "literal" | "one" | "star" | "all" | "dirs"; char?: string }> = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*" && p[i + 1] === "*") {
      i++;
      if (p[i + 1] === "/") { i++; tokens.push({ kind: "dirs" }); }
      else tokens.push({ kind: "all" });
    } else if (p[i] === "*") tokens.push({ kind: "star" });
    else if (p[i] === "?") tokens.push({ kind: "one" });
    else tokens.push({ kind: "literal", char: p[i] });
  }
  return (rel) => {
    let state = new Uint8Array(rel.length + 1); state[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(rel.length + 1);
      if (token.kind === "star" || token.kind === "all" || token.kind === "dirs") next[0] = state[0];
      let seen = false;
      for (let j = 1; j <= rel.length; j++) {
        seen = seen || state[j - 1] === 1;
        if (token.kind === "star" || token.kind === "all") next[j] = state[j] || (next[j - 1] && (token.kind === "all" || rel[j - 1] !== "/") ? 1 : 0);
        else if (token.kind === "dirs") next[j] = state[j] || (seen && rel[j - 1] === "/" ? 1 : 0);
        else next[j] = state[j - 1] && (token.kind === "one" ? rel[j - 1] !== "/" : rel[j - 1] === token.char) ? 1 : 0;
      }
      state = next;
    }
    return state[rel.length] === 1;
  };
}

// Download handler: supports single byte-ranges (206 Partial Content) and
// advertises Accept-Ranges.
async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions, abs: string, rel: string, headOnly: boolean): Promise<void> {
  const wsl = wslIo(opts);
  if (wsl) {
    const st = await wsl.stat(rel);
    if (!st) { text(res, 404, "Not found"); return; }
    if (st.kind === "dir") {
      if (headOnly) { res.writeHead(400, FILE_CORS); res.end(); return; }
      await listDir(res, opts, rel, "**/*");
      return;
    }
    if (headOnly) { sendHead(res, rel, st.size, st.mtimeMs); return; }
    if (await sendByteRange(req, res, opts, rel, abs, st.size, st.mtimeMs, wsl)) return;
    transferStage(opts, "GET", rel, "reading WSL file");
    const data = await wsl.readFile(rel, opts.maxBytes);
    const hash = createHash("sha256").update(data).digest("hex");
    const size = data.length;

    const start = 0;
    const end = size - 1;
    const slice = size === 0 ? Buffer.alloc(0) : data.subarray(start, end + 1);
    const headers: Record<string, string | number> = {
      ...FILE_CORS,
      "Content-Type": guessContentType(rel),
      "Content-Length": slice.length,
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(st.mtimeMs).toUTCString(),
      "X-File-Sha256": hash,
      "X-File-Path": encodeURIComponent(rel),
      "ETag": `"${hash}"`,
      "Content-Disposition": contentDisposition(rel),
    };
    res.writeHead(200, headers);
    if (headOnly || slice.length === 0) { res.end(); opts.onTransfer?.({ op: "GET", path: rel, ok: true, bytes: 0 }); return; }
    res.end(slice);
    opts.onTransfer?.({ op: "GET", path: rel, ok: true, bytes: slice.length });
    return;
  }
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) { text(res, 404, "Not found"); return; }
  if (st.isDirectory()) {
    if (headOnly) { res.writeHead(400, FILE_CORS); res.end(); return; }
    await listDir(res, opts, rel, "**/*");
    return;
  }
  if (headOnly) { sendHead(res, rel, st.size, st.mtimeMs); return; }
  const size = st.size;
  if (await sendByteRange(req, res, opts, rel, abs, size, st.mtimeMs)) return;
  transferStage(opts, "GET", rel, "hashing file");
  const hash = await sha256File(abs, opts.signal);
  const ctype = guessContentType(abs);

  const start = 0;
  const end = size - 1;
  const len = size === 0 ? 0 : (end - start + 1);
  const headers: Record<string, string | number> = {
    ...FILE_CORS,
    "Content-Type": ctype,
    "Content-Length": len,
    "Accept-Ranges": "bytes",
    "Last-Modified": st.mtime.toUTCString(),
    "X-File-Sha256": hash,
    "X-File-Path": encodeURIComponent(rel),
    "ETag": `"${hash}"`,
    "Content-Disposition": contentDisposition(abs),
  };
  res.writeHead(200, headers);
  if (headOnly || size === 0) { res.end(); opts.onTransfer?.({ op: "GET", path: rel, ok: true, bytes: 0 }); return; }
  const stream = fs.createReadStream(abs, { start, end });
  // Record successful completion only when the response has actually finished.
  opts.onTransfer?.({ op: "GET", path: rel, ok: true, bytes: len, detail: "streaming response" });
  await pipeline(stream, res, { signal: opts.signal });
}

// Parses `bytes=a-b`, `bytes=a-`, and the suffix form `bytes=-n`.
function parseRange(header: string, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null; // Unsupported/malformed ranges may be ignored.
  if (size <= 0) return false;
  let start: number, end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

// Upload handler: unique sibling temporary file, then rename/link publication,
// enforces maxBytes, and applies backpressure (pauses the request while the
// disk stream is full).
async function receiveFile(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions, abs: string, rel: string, overwrite: boolean): Promise<void> {
  transferStage(opts, "PUT", rel, "validating upload");
  if (req.headers["if-none-match"] && req.headers["if-none-match"] !== "*") throw httpError(400, "Only If-None-Match: * is supported for uploads");
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    json(res, 413, { ok: false, error: "File exceeds maxTransferBytes" });
    req.resume(); return;
  }
  const wsl = wslIo(opts);
  if (!wsl) await resolveSafeLocal(opts.workspaceRoot, rel);
  const st = wsl ? await wsl.stat(rel) : await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null; throw e;
  });
  if (st && ("kind" in st ? st.kind === "dir" : st.isDirectory())) throw new Error("Refusing to overwrite a directory");
  const exists = st != null;
  const createOnly = !overwrite || req.headers["if-none-match"] === "*";
  if (exists && createOnly) throw httpError(req.headers["if-none-match"] ? 412 : 409, "File already exists");
  const checkMatch = async () => {
    checkAborted(opts.signal);
    const expected = req.headers["if-match"];
    if (!expected) return;
    if (!wsl) await resolveSafeLocal(opts.workspaceRoot, rel);
    const current = wsl ? await wsl.stat(rel) : await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null; throw e;
    });
    if (!current) throw httpError(412, "File changed or no longer exists");
    if (expected === "*") return;
    const hash = wsl ? createHash("sha256").update(await wsl.readFile(rel, opts.maxBytes)).digest("hex") : await sha256File(abs, opts.signal);
    if (expected !== `"${hash}"`) throw httpError(412, "File SHA256 changed; read the latest file before writing");
  };
  await checkMatch();
  transferStage(opts, "PUT", rel, "receiving upload");
  if (wsl) {
    const data = await readRawBody(req, opts.maxBytes);
    await checkMatch();
    transferStage(opts, "PUT", rel, "committing WSL upload");
    const expected = req.headers["if-match"];
    const expectedSha256 = typeof expected === "string" && /^"[a-f0-9]{64}"$/.test(expected) ? expected.slice(1, -1) : undefined;
    await wsl.writeFile(rel, data, !createOnly, { expectedSha256, mustExist: expected === "*" });
    const hash = createHash("sha256").update(data).digest("hex");
    opts.onTransfer?.({ op: "PUT", path: rel, ok: true, bytes: data.length, detail: "committed" });
    json(res, exists ? 200 : 201, { ok: true, path: rel, bytes: data.length, sha256: hash, overwritten: exists });
    return;
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await resolveSafeLocal(opts.workspaceRoot, rel);
  const tmp = abs + ".portal-upload." + randomUUID() + ".tmp";
  const hash = createHash("sha256");
  let size = 0;
  const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    size += chunk.length;
    if (size > opts.maxBytes) { done(httpError(413, "File exceeds maxTransferBytes")); return; }
    hash.update(chunk); done(null, chunk);
  } });
  try {
    const mode = st && !("kind" in st) ? st.mode : 0o600;
    await pipeline(req, counter, fs.createWriteStream(tmp, { flags: "wx", mode }), { signal: opts.signal });
    await resolveSafeLocal(opts.workspaceRoot, rel);
    await checkMatch();
    checkAborted(opts.signal);
    transferStage(opts, "PUT", rel, "committing upload");
    const expected = req.headers["if-match"];
    await publishLocalFile(opts.workspaceRoot, rel, tmp, { createOnly,
      expectedSha256: typeof expected === "string" && /^"[a-f0-9]{64}"$/.test(expected) ? expected.slice(1, -1) : undefined,
      mustExist: expected === "*", signal: opts.signal });
    const sha256 = hash.digest("hex");
    opts.onTransfer?.({ op: "PUT", path: rel, ok: true, bytes: size, detail: "committed" });
    json(res, exists ? 200 : 201, { ok: true, path: rel, bytes: size, sha256, overwritten: exists });
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function deleteFile(res: http.ServerResponse, opts: FileHttpOptions, abs: string, rel: string): Promise<void> {
  checkAborted(opts.signal);
  if (!wslIo(opts)) await resolveSafeLocal(opts.workspaceRoot, rel);
  const wsl = wslIo(opts);
  if (wsl) {
    const st = await wsl.stat(rel);
    if (!st) { json(res, 404, { ok: false, error: "Not found" }); return; }
    if (st.kind === "dir") { json(res, 400, { ok: false, error: "Refusing to delete a directory" }); return; }
    await wsl.unlink(rel);
    opts.onTransfer?.({ op: "DELETE", path: rel, ok: true });
    json(res, 200, { ok: true, deleted: rel });
    return;
  }
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) { json(res, 404, { ok: false, error: "Not found" }); return; }
  if (st.isDirectory()) { json(res, 400, { ok: false, error: "Refusing to delete a directory" }); return; }
  await fsp.unlink(abs);
  opts.onTransfer?.({ op: "DELETE", path: rel, ok: true });
  json(res, 200, { ok: true, deleted: rel });
}

async function readJsonBody(req: http.IncomingMessage, max: number): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error("JSON body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readRawBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function packOp(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions): Promise<void> {
  const body = await readJsonBody(req, 1_000_000);
  const paths: string[] = Array.isArray(body?.paths) ? body.paths.map(String) : ["."];
  if (paths.length > 10000) throw new Error("Pack exceeds path limit");
  const entries: ZipEntry[] = [];
  let total = 0;
  const wsl = wslIo(opts);
  if (wsl) {
    for (const p of paths) {
      const st = await wsl.stat(p);
      if (!st) continue;
      if (st.kind === "file") {
        if (isDenied(normalizeRel(p))) continue;
        if (entries.length >= 10000) throw new Error("Pack exceeds 10000 files");
        const data = await wsl.readFile(p, opts.maxBytes - total);
        total += data.length;
        entries.push({ name: normalizeRel(p) || path.posix.basename(p), data });
        continue;
      }
      const kids = await wsl.list(p, true);
      for (const e of kids) {
        if (e.kind !== "file") continue;
        if (isDenied(e.rel)) continue;
        if (e.rel.split("/").some((seg) => SKIP_DIRS.has(seg))) continue;
        if (entries.length >= 10000) throw new Error("Pack exceeds 10000 files");
        const data = await wsl.readFile(e.rel, opts.maxBytes - total);
        total += data.length;
        entries.push({ name: e.rel, data });
      }
    }
    checkAborted(opts.signal);
    transferStage(opts, "PACK", paths.join(","), "compressing archive");
    const zip = await zipEntriesAsync(entries, opts.signal);
    res.writeHead(200, {
      ...FILE_CORS,
      "Content-Type": "application/zip",
      "Content-Length": zip.length,
      "Content-Disposition": 'attachment; filename="workspace.zip"',
    });
    res.end(zip);
    opts.onTransfer?.({ op: "PACK", path: paths.join(","), ok: true, bytes: zip.length, detail: `${entries.length} files` });
    return;
  }
  for (const p of paths) {
    const abs = await resolveSafeLocal(opts.workspaceRoot, p);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) continue;
    const collect = async (full: string) => {
      const rel = path.relative(opts.workspaceRoot, full).replace(/\\/g, "/");
      if (isDenied(rel)) return;
      checkAborted(opts.signal);
      const s = await fsp.lstat(full);
      if (s.isSymbolicLink()) return;
      await resolveSafeLocal(opts.workspaceRoot, rel);
      if (s.isDirectory()) {
        const kids = await fsp.readdir(full, { withFileTypes: true });
        for (const k of kids) {
          if (k.isDirectory() && (SKIP_DIRS.has(k.name) || k.name.startsWith("."))) continue;
          await collect(path.join(full, k.name));
        }
      } else if (s.isFile()) {
        if (entries.length >= 10000) throw new Error("Pack exceeds 10000 files");
        const data = await readLimitedFile(full, opts.maxBytes - total, opts.signal);
        total += data.length;
        entries.push({ name: rel, data });
      }
    };
    await collect(abs);
  }
  checkAborted(opts.signal);
  transferStage(opts, "PACK", paths.join(","), "compressing archive");
  const zip = await zipEntriesAsync(entries, opts.signal);
  res.writeHead(200, {
    ...FILE_CORS,
    "Content-Type": "application/zip",
    "Content-Length": zip.length,
    "Content-Disposition": 'attachment; filename="workspace.zip"',
  });
  res.end(zip);
  opts.onTransfer?.({ op: "PACK", path: paths.join(","), ok: true, bytes: zip.length, detail: `${entries.length} files` });
}

// Extract zip entries into dest; entry names are re-jailed (no `..`, no absolute).
async function unpackOp(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions, destRel: string): Promise<void> {
  if (wslIo(opts)) await wslIo(opts)!.stat(destRel);
  else await resolveSafeLocal(opts.workspaceRoot, destRel);
  const buf = await readRawBody(req, opts.maxBytes);
  transferStage(opts, "UNPACK", destRel, "validating archive");
  const entries = await unzipEntriesAsync(buf, { maxBytes: opts.maxBytes, maxEntries: 10000, signal: opts.signal });
  // Validate all destinations before writing the first file. Publication remains per-file, not a multi-file transaction.
  for (const e of entries) {
    const name = normalizeRel(e.name);
    if (!name || e.name.startsWith("/") || /^[a-zA-Z]:/.test(name) || isDenied(name) || name.split("/").includes("..")) throw new Error("Path is blocked in archive");
    const dest = normalizeRel(path.posix.join(normalizeRel(destRel || "."), name));
    if (wslIo(opts)) {
      if ((await wslIo(opts)!.stat(dest))?.kind === "dir") throw new Error("Refusing to overwrite a directory");
    } else {
      const abs = await resolveSafeLocal(opts.workspaceRoot, dest);
      const st = await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
      if (st?.isDirectory()) throw new Error("Refusing to overwrite a directory");
    }
  }
  const written: string[] = [];
  const wsl = wslIo(opts);
  if (wsl) {
    for (const e of entries) {
      const name = normalizeRel(e.name);
      if (!name || name.endsWith("/")) continue;
      const dest = normalizeRel(path.posix.join(normalizeRel(destRel || "."), name));
      await withFileLock(opts.workspaceRoot + "/" + wsl.resolvePosix(dest), opts.signal, () => wsl.writeFile(dest, e.data));
      written.push(dest);
    }
    opts.onTransfer?.({ op: "UNPACK", path: destRel || ".", ok: true, bytes: buf.length, detail: `${written.length} files` });
    json(res, 200, { ok: true, dest: normalizeRel(destRel || "."), count: written.length, files: written });
    return;
  }
  for (const e of entries) {
    const name = normalizeRel(e.name);
    if (!name || name.endsWith("/")) continue;
    const abs = await resolveSafeLocal(opts.workspaceRoot, path.posix.join(normalizeRel(destRel || "."), name));
    await withFileLock(opts.workspaceRoot + "/" + abs, opts.signal, async () => {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await resolveSafeLocal(opts.workspaceRoot, path.relative(opts.workspaceRoot, abs));
      const tmp = abs + ".portal-upload." + randomUUID() + ".tmp";
      try {
        const existing = await fsp.stat(abs).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        await fsp.writeFile(tmp, e.data, { flag: "wx", mode: existing?.mode ?? 0o600, signal: opts.signal });
        checkAborted(opts.signal);
        await publishLocalFile(opts.workspaceRoot, path.relative(opts.workspaceRoot, abs), tmp, { createOnly: false, signal: opts.signal });
      } finally { await fsp.rm(tmp, { force: true }).catch(() => undefined); }
    });
    written.push(path.relative(opts.workspaceRoot, abs).replace(/\\/g, "/"));
  }
  opts.onTransfer?.({ op: "UNPACK", path: destRel || ".", ok: true, bytes: buf.length, detail: `${written.length} files` });
  json(res, 200, { ok: true, dest: normalizeRel(destRel || "."), count: written.length, files: written });
}

function contentDisposition(file: string): string {
  const name = path.basename(file).replace(/[\r\n]/g, "_");
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
function sendHead(res: http.ServerResponse, rel: string, size: number, mtimeMs: number): void {
  res.writeHead(200, { ...FILE_CORS, "Content-Type": guessContentType(rel), "Content-Length": size,
    "Accept-Ranges": "bytes", "Last-Modified": new Date(mtimeMs).toUTCString(),
    "X-File-Path": encodeURIComponent(rel), "Content-Disposition": contentDisposition(rel) });
  res.end();
}
function transferStage(opts: FileHttpOptions, op: string, path: string, detail: string): void {
  checkAborted(opts.signal);
  opts.onTransfer?.({ op, path, ok: true, phase: "progress", detail });
}

/** Range responses hash only the returned bytes. A weak metadata ETag is NOT
 * a write precondition. If-Range is conservatively served as a full 200. */
async function sendByteRange(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions,
  rel: string, abs: string, size: number, mtimeMs: number, wsl?: WslIo): Promise<boolean> {
  if (!req.headers.range || req.headers["if-range"]) return false;
  const range = parseRange(String(req.headers.range), size);
  if (range === null) return false;
  if (range === false) { res.writeHead(416, { ...FILE_CORS, "Content-Range": `bytes */${size}` }); res.end(); return true; }
  const length = range.end - range.start + 1;
  if (length > Math.min(opts.maxBytes, 4 * 1024 * 1024)) throw httpError(413, "Range exceeds 4 MiB; request smaller ranges");
  transferStage(opts, "GET", rel, "reading byte range");
  let data: Buffer;
  if (wsl) {
    data = await wsl.readRange(rel, range.start, length);
    const after = await wsl.stat(rel);
    if (!after || after.size !== size || after.mtimeMs !== mtimeMs) throw httpError(412, "File changed during range read");
  } else {
    const file = await fsp.open(await resolveSafeLocal(opts.workspaceRoot, rel), "r");
    try {
      const before = await file.stat();
      if (before.size !== size || before.mtimeMs !== mtimeMs) throw httpError(412, "File changed before range read");
      data = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        checkAborted(opts.signal);
        const read = await file.read(data, offset, length - offset, range.start + offset);
        if (!read.bytesRead) throw httpError(412, "File changed during range read");
        offset += read.bytesRead;
      }
      const after = await file.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw httpError(412, "File changed during range read");
    } finally { await file.close(); }
  }
  checkAborted(opts.signal);
  res.writeHead(206, { ...FILE_CORS, "Content-Type": guessContentType(rel), "Content-Length": length,
    "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Accept-Ranges": "bytes",
    "Last-Modified": new Date(mtimeMs).toUTCString(), "ETag": `W/"${size}-${mtimeMs}"`,
    "X-Range-Sha256": createHash("sha256").update(data).digest("hex"),
    "X-File-Path": encodeURIComponent(rel), "Content-Disposition": contentDisposition(rel) });
  opts.onTransfer?.({ op: "GET", path: rel, ok: true, bytes: length, detail: "range response" });
  res.end(data);
  return true;
}
