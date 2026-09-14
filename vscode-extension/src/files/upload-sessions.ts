/** Bounded, retry-safe chunk sessions. Session metadata is process-local;
 * chunks live in private OS temporary directories, never in the workspace. */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { FileService, FileServiceOptions, sha256 } from "./service";
import { checkAborted, fileError, readLimitedFile, withFileLock } from "./file-ops";

const CHUNK_BYTES = 128 * 1024;
const TTL = 30 * 60 * 1000;
type Receipt = { path: string; bytes: number; sha256: string; committed: boolean };
interface Session {
  id: string; directory: string; target: string; size: number; hash: string; expected?: string;
  expires: number; chunks: Map<number, string>; busy: boolean; receipt?: Receipt;
}
export class UploadSessions {
  private readonly sessions = new Map<string, Session>();
  private pending = 0;
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: FileServiceOptions) {
    this.timer = setInterval(() => { void this.prune().catch(() => undefined); }, 60_000);
    this.timer.unref();
  }
  private async prune() {
    for (const [id, session] of this.sessions) {
      if (session.expires <= Date.now() && !session.busy) {
        this.sessions.delete(id);
        await fsp.rm(session.directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
  async begin(target: string, size: number, hash: string, expected: string | undefined, signal: AbortSignal) {
    await this.prune();
    const max = Math.min(this.options.maxTransferBytes ?? 64 * 1024 * 1024, 64 * 1024 * 1024);
    if (this.disposed) throw fileError(410, "File service is stopped");
    if (!Number.isSafeInteger(size) || size < 0 || size > max) throw fileError(413, `Upload must be between 0 and ${max} bytes`);
    if (this.sessions.size + this.pending >= 4) throw fileError(429, "At most four upload sessions; finish or cancel an existing session");
    this.pending++;
    let directory: string | undefined;
    try {
      const service = new FileService({ ...this.options, signal });
      await service.resolve(target);
      directory = await fsp.mkdtemp(path.join(os.tmpdir(), "portal-upload-"));
      checkAborted(signal);
      if (this.disposed) throw fileError(410, "File service is stopped");
      const session: Session = { id: randomUUID(), directory, target, size, hash, expected, expires: Date.now() + TTL, chunks: new Map(), busy: false };
      this.sessions.set(session.id, session);
      directory = undefined;
      return this.describe(session);
    } finally {
      this.pending--;
      if (directory) await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  private describe(session: Session) {
    const count = Math.ceil(session.size / CHUNK_BYTES);
    return { upload_id: session.id, path: session.target, total_bytes: session.size, chunk_bytes: CHUNK_BYTES,
      chunk_count: count, expires_at: new Date(session.expires).toISOString(), committed: !!session.receipt,
      missing_chunks: session.receipt ? [] : Array.from({ length: count }, (_, i) => i).filter(i => !session.chunks.has(i)),
      result: session.receipt ?? null };
  }
  private async use<T>(id: string, signal: AbortSignal, action: (session: Session) => Promise<T>): Promise<T> {
    return withFileLock("upload-session:" + id, signal, async () => {
      if (this.disposed) throw fileError(410, "File service is stopped");
      const session = this.sessions.get(id);
      if (!session || session.expires <= Date.now()) throw fileError(410, "Upload session expired or unknown; start a new session");
      session.busy = true;
      try { return await action(session); } finally { session.busy = false; }
    });
  }
  async status(id: string, signal: AbortSignal) {
    return this.use(id, signal, async session => this.describe(session));
  }
  async chunk(id: string, index: number, data: Buffer, signal: AbortSignal) {
    return this.use(id, signal, async session => {
      if (session.receipt) throw fileError(409, "Upload already committed");
      const count = Math.ceil(session.size / CHUNK_BYTES);
      if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw fileError(400, "Invalid chunk index");
      const expectedSize = Math.min(CHUNK_BYTES, session.size - index * CHUNK_BYTES);
      if (data.length !== expectedSize) throw fileError(400, `Chunk must contain ${expectedSize} bytes`);
      const hash = sha256(data), previous = session.chunks.get(index);
      if (previous) {
        if (previous !== hash) throw fileError(409, "Chunk retry differs from acknowledged content");
        return { upload_id: id, index, sha256: hash, duplicate: true };
      }
      const file = path.join(session.directory, String(index));
      try {
        await fsp.writeFile(file, data, { flag: "wx", mode: 0o600, signal });
        checkAborted(signal);
        session.chunks.set(index, hash);
      } catch (error) { await fsp.rm(file, { force: true }).catch(() => undefined); throw error; }
      return { upload_id: id, index, sha256: hash, duplicate: false };
    });
  }
  async commit(id: string, signal: AbortSignal) {
    return this.use(id, signal, async session => {
      if (session.receipt) return { ...session.receipt, replayed: true };
      const count = Math.ceil(session.size / CHUNK_BYTES);
      if (session.chunks.size !== count) throw fileError(409, "Missing chunks; call upload_status before commit");
      const assembled = path.join(session.directory, "assembled-" + randomUUID());
      const hash = createHash("sha256");
      try {
        const handle = await fsp.open(assembled, "wx", 0o600);
        try {
          for (let i = 0; i < count; i++) {
            checkAborted(signal);
            const chunk = await readLimitedFile(path.join(session.directory, String(i)), CHUNK_BYTES, signal);
            if (sha256(chunk) !== session.chunks.get(i)) throw fileError(409, "Stored chunk integrity check failed");
            hash.update(chunk); await handle.writeFile(chunk);
          }
        } finally { await handle.close(); }
        if (hash.digest("hex") !== session.hash) throw fileError(409, "Complete upload SHA256 mismatch");
        const bytes = await readLimitedFile(assembled, session.size, signal);
        if (bytes.length !== session.size) throw fileError(409, "Upload size mismatch");
        const service = new FileService({ ...this.options, signal });
        session.receipt = await service.writeBytes(session.target, bytes, session.expected);
        // Keep the receipt for idempotent commit/status retries until expiry.
        await fsp.rm(session.directory, { recursive: true, force: true }).catch(() => undefined);
        return { ...session.receipt, replayed: false };
      } finally { await fsp.rm(assembled, { force: true }).catch(() => undefined); }
    });
  }
  async cancel(id: string, signal: AbortSignal) {
    return this.use(id, signal, async session => {
      if (session.receipt) { this.sessions.delete(id); return { cancelled: false, committed: true, result: session.receipt }; }
      this.sessions.delete(id);
      await fsp.rm(session.directory, { recursive: true, force: true });
      return { cancelled: true, committed: false };
    });
  }
  async dispose() {
    this.disposed = true; clearInterval(this.timer);
    for (const [id, session] of this.sessions) {
      await withFileLock("upload-session:" + id, undefined, async () => {
        await fsp.rm(session.directory, { recursive: true, force: true }).catch(() => undefined);
        this.sessions.delete(id);
      });
    }
  }
}
