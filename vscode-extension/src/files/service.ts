/** Workspace file service used by native tools and the HTTP publication path. */
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { isDenied, normalizeRel, resolveSafeLocal } from "./paths";
import { WslIo } from "./wsl-io";
import { SKIP_DIRS } from "../tools/workspace";
import { checkAborted, fileError, readLimitedFile, publishLocalFile, withFileLock } from "./file-ops";

export interface FileServiceOptions {
  workspaceRoot: string; wslDistro?: string; posixRoot?: string; maxTransferBytes?: number; signal?: AbortSignal;
}
export const TEXT_FILE_LIMIT = 1024 * 1024;
export const TEXT_PAGE_LIMIT = 64 * 1024;
export const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
export class FileService {
  readonly wsl?: WslIo;
  constructor(readonly options: FileServiceOptions) {
    if (options.wslDistro && options.posixRoot) this.wsl = new WslIo(options.wslDistro, options.posixRoot, options.signal);
  }
  async resolve(rel: string): Promise<string> {
    checkAborted(this.options.signal);
    if (this.wsl) { const abs = this.wsl.resolvePosix(rel); await this.wsl.stat(rel); return abs; }
    return resolveSafeLocal(this.options.workspaceRoot, rel);
  }
  async readBytes(rel: string, max = TEXT_FILE_LIMIT): Promise<Buffer> {
    const abs = await this.resolve(rel);
    if (this.wsl) return this.wsl.readFile(rel, max);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw fileError(400, "Select a regular file");
    if (stat.size > max) throw fileError(413, "File exceeds native text limit; use HTTP for large/binary files");
    return readLimitedFile(abs, max, this.options.signal);
  }
  async readText(rel: string, offset = 0, maxBytes = TEXT_PAGE_LIMIT, expectedSha256?: string) {
    const data = await this.readBytes(rel);
    // Validate the complete bounded file so binary data cannot be mistaken for text.
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (data.includes(0)) throw fileError(400, "Binary file: use the HTTP file API");
    const hash = sha256(data);
    if (expectedSha256 && hash !== expectedSha256) throw fileError(412, "File changed between pages; restart the read");
    if (offset > data.length || (offset < data.length && (data[offset] & 0xc0) === 0x80)) throw fileError(400, "Offset must be a UTF-8 character boundary within the file");
    let end = Math.min(data.length, offset + maxBytes);
    while (end < data.length && end > offset && (data[end] & 0xc0) === 0x80) end--;
    while (end > offset && Buffer.byteLength(JSON.stringify(data.subarray(offset, end).toString("utf8"))) > TEXT_PAGE_LIMIT) {
      end = offset + Math.floor((end - offset) / 2);
      while (end > offset && (data[end] & 0xc0) === 0x80) end--;
    }
    if (end === offset && offset < data.length) throw fileError(400, "Page is too small for the next UTF-8 character");
    return { path: normalizeRel(rel), content: data.subarray(offset, end).toString("utf8"), encoding: "utf-8",
      bom: data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), newline: data.includes(Buffer.from("\r\n")) ? "CRLF" : "LF",
      sha256: hash, total_bytes: data.length, offset, next_offset: end, eof: end === data.length };
  }
  /** No expected hash means create-only. Overwrite requires a full-file SHA256. */
  async writeBytes(rel: string, data: Buffer, expectedSha256?: string) {
    const max = this.options.maxTransferBytes ?? 64 * 1024 * 1024;
    if (data.length > max) throw fileError(413, "File exceeds maxTransferBytes");
    const abs = await this.resolve(rel);
    return withFileLock(this.options.workspaceRoot + "/" + abs, this.options.signal, async () => {
      checkAborted(this.options.signal);
      if (this.wsl) {
        await this.wsl.writeFile(rel, data, expectedSha256 !== undefined, { expectedSha256 });
      } else {
        await resolveSafeLocal(this.options.workspaceRoot, rel);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await resolveSafeLocal(this.options.workspaceRoot, rel);
        const previous = await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
        const tmp = abs + ".portal-upload." + randomUUID() + ".tmp";
        try {
          await fsp.writeFile(tmp, data, { flag: "wx", mode: previous?.mode ?? 0o600, signal: this.options.signal });
          await publishLocalFile(this.options.workspaceRoot, rel, tmp, { createOnly: expectedSha256 === undefined, expectedSha256, signal: this.options.signal });
        } finally { await fsp.rm(tmp, { force: true }).catch(() => undefined); }
      }
      return { path: normalizeRel(rel), bytes: data.length, sha256: sha256(data), committed: true };
    });
  }
  async patch(rel: string, oldText: string, newText: string, expectedSha256: string) {
    const data = await this.readBytes(rel);
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (data.includes(0)) throw fileError(400, "Binary file: patch is text-only");
    if (sha256(data) !== expectedSha256) throw fileError(412, "File changed before patch");
    const text = data.toString("utf8");
    // Preserve existing newline convention and BOM; no fuzzy match or global replace.
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/\n/g, eol);
    const old = normalize(oldText), replacement = normalize(newText);
    const index = text.indexOf(old);
    if (!old || index < 0 || text.indexOf(old, index + 1) >= 0) throw fileError(409, "Patch must match exactly one occurrence");
    const result = Buffer.from(text.slice(0, index) + replacement + text.slice(index + old.length), "utf8");
    if (result.length > TEXT_FILE_LIMIT) throw fileError(413, "Patched file exceeds native text limit");
    return this.writeBytes(rel, result, expectedSha256);
  }
  /** Shallow pagination avoids unbounded recursive walks; descend explicitly. */
  async list(rel: string, limit = 100, cursor?: string) {
    const abs = await this.resolve(rel);
    const directory = this.wsl ? (await this.wsl.stat(rel))?.kind === "dir" : (await fsp.stat(abs)).isDirectory();
    if (!directory) throw fileError(400, "Select a directory");
    const prefix = normalizeRel(rel) === "." ? "" : normalizeRel(rel);
    let after = "";
    if (cursor) {
      if (cursor.length > 8192) throw fileError(400, "Invalid cursor");
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (decoded.path !== prefix || typeof decoded.after !== "string") throw fileError(400, "Cursor belongs to a different directory");
      after = decoded.after;
    }
    let names: Array<{ name: string; kind: "file" | "dir" }> = [];
    if (this.wsl) {
      const items = await this.wsl.list(rel, false, { maxEntries: 10001 });
      if (items.length > 10000) throw fileError(413, "Directory is too large; use a narrower path or HTTP listing");
      names = items.map(item => ({ name: item.name, kind: item.kind }));
    } else {
      const dir = await fsp.opendir(abs);
      for await (const entry of dir) {
        checkAborted(this.options.signal);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
        names.push({ name: entry.name, kind: entry.isDirectory() ? "dir" : "file" });
        if (names.length > 10000) throw fileError(413, "Directory is too large; use a narrower path or HTTP listing");
      }
    }
    names = names.filter(item => !item.name.startsWith(".") && !SKIP_DIRS.has(item.name) && !isDenied((prefix ? prefix + "/" : "") + item.name))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).filter(item => item.name > after);
    const page: Array<{ path: string; kind: "file" | "dir" }> = [];
    let consumed = 0, bytes = 0;
    for (const item of names) {
      if (page.length >= limit) break;
      const entry = { path: (prefix ? prefix + "/" : "") + item.name, kind: item.kind };
      const n = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + n > TEXT_PAGE_LIMIT && page.length) break;
      if (n > TEXT_PAGE_LIMIT) throw fileError(413, "Path exceeds response limit");
      page.push(entry); bytes += n; consumed++;
    }
    const more = consumed < names.length;
    const next = more && consumed ? Buffer.from(JSON.stringify({ path: prefix, after: names[consumed - 1].name })).toString("base64url") : null;
    return { path: prefix || ".", entries: page, next_cursor: next, truncated: more, recursive: false };
  }
}
