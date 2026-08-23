/**
 * HTTP file-transfer API mounted at /files/<routeToken> on the same local
 * server as MCP (exposed through the same tunnel).
 *
 * Operations:
 *   GET/HEAD  ?op=info          capability + endpoint listing
 *   GET       ?glob=&path=      list files (JSON with size/mtime)
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
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { guessContentType, isDenied, parseFilesRequest, resolveSafe, normalizeRel } from "./paths";
import { unzipEntries, zipEntries, ZipEntry } from "./zip";
import { SKIP_DIRS } from "../tools/workspace";

export interface FileHttpOptions {
  workspaceRoot: string;
  routeToken: string;
  maxBytes: number;
  filesBaseUrl?: string;
  onTransfer?: (info: { op: string; path: string; ok: boolean; bytes?: number; detail?: string }) => void;
}

// Wide-open CORS (same rationale as mcp-server) incl. headers clients send
// through ngrok.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Content-Range, Range, ngrok-skip-browser-warning",
  "Access-Control-Expose-Headers": "Content-Length, Accept-Ranges, Content-Range, X-File-Sha256, ETag, X-File-Path",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...cors, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function text(res: http.ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { ...cors, "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

// Fast-path check used by the MCP server to delegate /files requests.
export function isFilesRequest(urlStr: string | undefined, token: string): boolean {
  if (!urlStr || !token) return false;
  try { return parseFilesRequest(urlStr, token) !== null; } catch { return false; }
}

// Route by method + op; errors map to 400/403/404/405/409.
export async function handleFilesHttp(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions): Promise<void> {
  const parsed = parseFilesRequest(req.url || "/", opts.routeToken);
  if (!parsed) { text(res, 404, "Not Found"); return; }
  const op = (parsed.query.get("op") || "").toLowerCase();
  const method = (req.method || "GET").toUpperCase();
  try {
    if (method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (method === "GET" && (parsed.rel === "" || op === "info")) {
      if (op === "info" || parsed.query.get("info") === "1") {
        json(res, 200, {
          ok: true,
          filesBaseUrl: opts.filesBaseUrl,
          maxBytes: opts.maxBytes,
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

    const abs = resolveSafe(opts.workspaceRoot, parsed.rel);
    if (method === "GET" || method === "HEAD") {
      await sendFile(req, res, opts, abs, parsed.rel, method === "HEAD");
      return;
    }
    if (method === "PUT") {
      await receiveFile(req, res, opts, abs, parsed.rel, parsed.query.get("overwrite") !== "false");
      return;
    }
    if (method === "DELETE") {
      await deleteFile(res, opts, abs, parsed.rel);
      return;
    }
    text(res, 405, "Method Not Allowed");
  } catch (e: any) {
    opts.onTransfer?.({ op: method, path: parsed.rel, ok: false, detail: e?.message });
    const msg = e?.message ?? String(e);
    const status = /escapes workspace|blocked/i.test(msg) ? 403 : 400;
    json(res, status, { ok: false, error: msg });
  }
}

// Recursive listing capped at 2000 entries; hidden, SKIP_DIRS and DENY paths
// are skipped.
async function listDir(res: http.ServerResponse, opts: FileHttpOptions, relDir: string, globPat: string): Promise<void> {
  const root = resolveSafe(opts.workspaceRoot, relDir || ".");
  const st = await fsp.stat(root).catch(() => null);
  if (!st) { json(res, 404, { ok: false, error: "Not found" }); return; }
  if (st.isFile()) {
    json(res, 200, { ok: true, files: [await statEntry(opts.workspaceRoot, root)] });
    return;
  }
  const files: Array<Record<string, unknown>> = [];
  const walk = async (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= 2000) return;
      const full = path.join(dir, e.name);
      const rel = path.relative(opts.workspaceRoot, full).replace(/\\/g, "/");
      if (isDenied(rel)) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(full);
      } else if (e.isFile()) {
        if (globPat && globPat !== "**/*" && !simpleGlob(globPat, rel)) continue;
        files.push(await statEntry(opts.workspaceRoot, full));
      }
    }
  };
  await walk(root);
  json(res, 200, { ok: true, root: normalizeRel(relDir || "."), count: files.length, files });
  opts.onTransfer?.({ op: "LIST", path: relDir || ".", ok: true, bytes: files.length });
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

// Same tiny matcher as tools/glob, duplicated to keep the modules independent.
function simpleGlob(pattern: string, name: string): boolean {
  // reuse ** / * / ? — same tiny matcher as tools/glob
  const p = pattern.replace(/\\/g, "/");
  const n = name.replace(/\\/g, "/");
  let i = 0, j = 0, star = -1, match = 0;
  while (i < p.length) {
    if (p[i] === "*") {
      if (p[i + 1] === "*") { i += 2; if (i === p.length) return true; }
      else { star = i++; match = j; continue; }
    }
    if (j < n.length && (p[i] === "?" || p[i] === n[j])) { i++; j++; continue; }
    if (star !== -1) { i = star + 1; j = ++match; continue; }
    return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length && j === n.length;
}

// Streamed SHA-256 — returned as X-File-Sha256 and reused as the ETag.
async function sha256File(abs: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(abs), hash);
  return hash.digest("hex");
}

// Download handler: supports single byte-ranges (206 Partial Content) and
// advertises Accept-Ranges.
async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions, abs: string, rel: string, headOnly: boolean): Promise<void> {
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) { text(res, 404, "Not found"); return; }
  if (st.isDirectory()) {
    await listDir(res, opts, rel, "**/*");
    return;
  }
  const size = st.size;
  const hash = await sha256File(abs);
  const ctype = guessContentType(abs);
  const range = parseRange(String(req.headers.range || ""), size);
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const len = size === 0 ? 0 : (end - start + 1);
  const headers: Record<string, string | number> = {
    ...cors,
    "Content-Type": ctype,
    "Content-Length": len,
    "Accept-Ranges": "bytes",
    "Last-Modified": st.mtime.toUTCString(),
    "X-File-Sha256": hash,
    "X-File-Path": rel,
    "ETag": `"${hash}"`,
    "Content-Disposition": `attachment; filename="${path.basename(abs).replace(/"/g, "")}"`,
  };
  if (range) {
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(206, headers);
  } else {
    res.writeHead(200, headers);
  }
  if (headOnly || size === 0) { res.end(); opts.onTransfer?.({ op: "GET", path: rel, ok: true, bytes: 0 }); return; }
  const stream = fs.createReadStream(abs, { start, end });
  stream.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
  opts.onTransfer?.({ op: "GET", path: rel, ok: true, bytes: len });
}

// Parses `bytes=a-b`, `bytes=a-`, and the suffix form `bytes=-n`.
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || size <= 0) return null;
  let start = m[1] === "" ? NaN : Number(m[1]);
  let end = m[2] === "" ? NaN : Number(m[2]);
  if (Number.isNaN(start) && !Number.isNaN(end)) { start = Math.max(0, size - end); end = size - 1; }
  else {
    if (Number.isNaN(start)) return null;
    if (Number.isNaN(end)) end = size - 1;
  }
  if (start < 0 || end >= size || start > end) return null;
  return { start, end };
}

// Upload handler: streams to <file>.portal-upload.tmp then renames (atomic),
// enforces maxBytes, and applies backpressure (pauses the request while the
// disk stream is full).
async function receiveFile(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions, abs: string, rel: string, overwrite: boolean): Promise<void> {
  if (isDenied(rel)) { text(res, 403, "Path is blocked"); return; }
  const exists = await fsp.stat(abs).then((s) => s.isFile()).catch(() => false);
  if (exists && !overwrite) { json(res, 409, { ok: false, error: "exists" }); return; }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + ".portal-upload.tmp";
  await fsp.rm(tmp, { force: true });
  const ws = fs.createWriteStream(tmp);
  let size = 0;
  let aborted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) {
          aborted = true;
          req.destroy();
          ws.destroy();
          reject(new Error(`File exceeds maxTransferBytes (${opts.maxBytes})`));
          return;
        }
        if (!ws.write(c)) req.pause();
      });
      ws.on("drain", () => req.resume());
      req.on("end", () => ws.end());
      req.on("error", reject);
      ws.on("error", reject);
      ws.on("finish", () => resolve());
    });
    await fsp.rename(tmp, abs);
    const hash = await sha256File(abs);
    opts.onTransfer?.({ op: "PUT", path: rel, ok: true, bytes: size });
    json(res, exists ? 200 : 201, { ok: true, path: rel, bytes: size, sha256: hash, overwritten: exists });
  } catch (e: any) {
    try { await fsp.rm(tmp, { force: true }); } catch { /* ignore */ }
    opts.onTransfer?.({ op: "PUT", path: rel, ok: false, detail: e?.message });
    if (!aborted) json(res, 500, { ok: false, error: e?.message ?? String(e) });
    else json(res, 413, { ok: false, error: e?.message ?? String(e) });
  }
}

async function deleteFile(res: http.ServerResponse, opts: FileHttpOptions, abs: string, rel: string): Promise<void> {
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
  // Collect files under the requested paths, respecting DENY + the size cap.
  const entries: ZipEntry[] = [];
  let total = 0;
  for (const p of paths) {
    const abs = resolveSafe(opts.workspaceRoot, p);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) continue;
    const collect = async (full: string) => {
      const rel = path.relative(opts.workspaceRoot, full).replace(/\\/g, "/");
      if (isDenied(rel)) return;
      const s = await fsp.stat(full);
      if (s.isDirectory()) {
        const kids = await fsp.readdir(full, { withFileTypes: true });
        for (const k of kids) {
          if (k.isDirectory() && (SKIP_DIRS.has(k.name) || k.name.startsWith("."))) continue;
          await collect(path.join(full, k.name));
        }
      } else if (s.isFile()) {
        total += s.size;
        if (total > opts.maxBytes) throw new Error("Pack exceeds maxTransferBytes");
        entries.push({ name: rel, data: await fsp.readFile(full) });
      }
    };
    await collect(abs);
  }
  const zip = zipEntries(entries);
  res.writeHead(200, {
    ...cors,
    "Content-Type": "application/zip",
    "Content-Length": zip.length,
    "Content-Disposition": 'attachment; filename="workspace.zip"',
  });
  res.end(zip);
  opts.onTransfer?.({ op: "PACK", path: paths.join(","), ok: true, bytes: zip.length, detail: `${entries.length} files` });
}

// Extract zip entries into dest; entry names are re-jailed (no `..`, no absolute).
async function unpackOp(req: http.IncomingMessage, res: http.ServerResponse, opts: FileHttpOptions, destRel: string): Promise<void> {
  const buf = await readRawBody(req, opts.maxBytes);
  const entries = unzipEntries(buf);
  const written: string[] = [];
  for (const e of entries) {
    const name = normalizeRel(e.name);
    if (!name || name.endsWith("/")) continue;
    if (isDenied(name) || name.includes("..")) continue;
    const abs = resolveSafe(opts.workspaceRoot, path.posix.join(normalizeRel(destRel || "."), name));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, e.data);
    written.push(path.relative(opts.workspaceRoot, abs).replace(/\\/g, "/"));
  }
  opts.onTransfer?.({ op: "UNPACK", path: destRel || ".", ok: true, bytes: buf.length, detail: `${written.length} files` });
  json(res, 200, { ok: true, dest: normalizeRel(destRel || "."), count: written.length, files: written });
}
