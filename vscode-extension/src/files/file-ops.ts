/** Shared local publication and locking primitives for HTTP and MCP tools. */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { resolveSafeLocal } from "./paths";

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("File operation aborted");
}
export function fileError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
export async function sha256File(abs: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(abs), hash, { signal });
  return hash.digest("hex");
}
export async function readLimitedFile(abs: string, max: number, signal?: AbortSignal): Promise<Buffer> {
  const stream = fs.createReadStream(abs, { signal });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > max) throw fileError(413, "File exceeds the operation byte limit; use ranged HTTP or chunked uploads");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } finally { stream.destroy(); }
}

const fileLocks = new Map<string, Promise<void>>();
export async function withFileLock<T>(key: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  if (process.platform === "win32") key = key.toLowerCase();
  const previous = fileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  fileLocks.set(key, next);
  // Do not release ahead of the previous writer on cancellation: that would
  // allow a later writer to bypass the lock. Cancelled waiters perform no I/O.
  try { await previous; checkAborted(signal); return await action(); }
  finally { release(); if (fileLocks.get(key) === next) fileLocks.delete(key); }
}

/** Caller holds the shared path lock. This is not an OS-level CAS against
 * external editors: check immediately before publication, never claim more. */
export async function publishLocalFile(root: string, rel: string, tmp: string, options: {
  createOnly: boolean; expectedSha256?: string; mustExist?: boolean; signal?: AbortSignal;
}): Promise<void> {
  const abs = await resolveSafeLocal(root, rel);
  checkAborted(options.signal);
  const stat = await fsp.stat(abs).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
  if (stat?.isDirectory()) throw fileError(409, "Refusing to replace a directory");
  if ((options.mustExist || options.expectedSha256) && !stat) throw fileError(412, "File no longer exists");
  if (options.expectedSha256 && await sha256File(abs, options.signal) !== options.expectedSha256) throw fileError(412, "File changed; read the latest version before writing");
  checkAborted(options.signal);
  if (options.createOnly) await fsp.link(tmp, abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EEXIST") throw fileError(412, "File already exists"); throw e;
  });
  else await fsp.rename(tmp, abs);
}
