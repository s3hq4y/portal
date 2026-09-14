/**
 * Zero-dependency ZIP support (read + write) built on zlib raw deflate.
 * Supports only STORE (0) and DEFLATE (8); no encryption, no zip64 —
 * enough for bundling workspace files.
 */
import { deflateRawSync, inflateRawSync, deflateRaw, inflateRaw } from "node:zlib";
import { promisify } from "node:util";
const deflateAsync = promisify(deflateRaw);
const inflateAsync = promisify(inflateRaw);

export interface ZipEntry { name: string; data: Buffer }

// Standard CRC-32 (IEEE) with a lazily built 256-entry table.
let crcTable: number[] | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

// Write: per-entry local header + data, then the central directory + EOCD.
export function zipEntries(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
    const raw = e.data;
    const deflated = deflateRawSync(raw);
    const useStore = deflated.length >= raw.length;
    const payload = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(payload.length), u32(raw.length),
      u16(name.length), u16(0),
      name, payload,
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(payload.length), u32(raw.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// Read: locate the EOCD (scanning backwards), walk the central directory,
// and inflate each entry.
export function unzipEntries(buf: Buffer): ZipEntry[] {
  // Find EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (EOCD missing)");
  const count = buf.readUInt16LE(eocd + 8);
  let cdOff = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(cdOff) !== 0x02014b50) throw new Error("Bad central directory");
    const method = buf.readUInt16LE(cdOff + 10);
    const compSize = buf.readUInt32LE(cdOff + 20);
    const uncomp = buf.readUInt32LE(cdOff + 24);
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commentLen = buf.readUInt16LE(cdOff + 32);
    const localOff = buf.readUInt32LE(cdOff + 42);
    const name = buf.subarray(cdOff + 46, cdOff + 46 + nameLen).toString("utf8");
    cdOff += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const locNameLen = buf.readUInt16LE(localOff + 26);
    const locExtra = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + locNameLen + locExtra;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = inflateRawSync(comp);
    else throw new Error(`Unsupported zip method ${method} for ${name}`);
    // Some writers leave the uncompressed size as 0 — trust the inflate result.
    if (data.length !== uncomp && uncomp !== 0) {
      // some zips leave uncomp=0; accept inflate result
    }
    out.push({ name, data });
  }
  return out;
}

export async function zipEntriesAsync(entries: ZipEntry[], signal?: AbortSignal): Promise<Buffer> {
  if (entries.length > 10000) throw new Error("Pack exceeds 10000 files");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (signal?.aborted) throw new Error("File operation aborted");
    await new Promise<void>(resolve => setImmediate(resolve));
    const name = Buffer.from(e.name.replace(/\\/g, "/"), "utf8");
    const raw = e.data;
    const deflated = await deflateAsync(raw);
    const useStore = deflated.length >= raw.length;
    const payload = useStore ? raw : deflated;
    const method = useStore ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(payload.length), u32(raw.length),
      u16(name.length), u16(0),
      name, payload,
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(crc), u32(payload.length), u32(raw.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralBuf, eocd]);
}


export async function unzipEntriesAsync(buf: Buffer, limits: { maxBytes: number; maxEntries: number; signal?: AbortSignal }): Promise<ZipEntry[]> {
  const bounds = (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buf.length) throw new Error("ZIP contains an out-of-bounds record");
  };
  if (buf.length > limits.maxBytes) throw new Error("ZIP exceeds maxTransferBytes");
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (EOCD missing)");
  const count = buf.readUInt16LE(eocd + 10);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0 || count !== buf.readUInt16LE(eocd + 8) || count === 0xffff) throw new Error("Multi-disk/ZIP64 archives are not supported");
  if (count > limits.maxEntries) throw new Error("ZIP exceeds entry limit");
  let cd = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12), cdEnd = cd + cdSize;
  bounds(cd, cdSize);
  if (cdEnd > eocd) throw new Error("Invalid central directory");
  const names = new Set<string>(), out: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (limits.signal?.aborted) throw new Error("File operation aborted");
    await new Promise<void>(resolve => setImmediate(resolve));
    bounds(cd, 46);
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("Bad central directory");
    const flags = buf.readUInt16LE(cd + 8), method = buf.readUInt16LE(cd + 10);
    const checksum = buf.readUInt32LE(cd + 16), compressed = buf.readUInt32LE(cd + 20), size = buf.readUInt32LE(cd + 24);
    const nameLength = buf.readUInt16LE(cd + 28), extraLength = buf.readUInt16LE(cd + 30), commentLength = buf.readUInt16LE(cd + 32);
    const disk = buf.readUInt16LE(cd + 34), attributes = buf.readUInt32LE(cd + 38), local = buf.readUInt32LE(cd + 42);
    bounds(cd + 46, nameLength + extraLength + commentLength);
    if (cd + 46 + nameLength + extraLength + commentLength > cdEnd) throw new Error("Invalid central record size");
    const nameBytes = buf.subarray(cd + 46, cd + 46 + nameLength);
    const name = nameBytes.toString("utf8").replace(/\\/g, "/");
    cd += 46 + nameLength + extraLength + commentLength;
    if (flags & 1 || disk !== 0 || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error("Encrypted/multi-disk/ZIP64 archives are not supported");
    if (((attributes >>> 16) & 0xf000) === 0xa000) throw new Error("Path is blocked: archive symlink");
    if (method !== 0 && method !== 8) throw new Error("Unsupported zip compression method");
    if (!name || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || /[\x00-\x1f\x7f]/.test(name) || name.split("/").includes("..")) throw new Error("Path is blocked in archive");
    const key = name.split("/").filter(part => part && part !== ".").join("/");
    const normalized = process.platform === "win32" ? key.toLowerCase() : key;
    if (!normalized || names.has(normalized)) throw new Error("Duplicate/empty ZIP destination");
    names.add(normalized);
    bounds(local, 30);
    if (buf.readUInt32LE(local) !== 0x04034b50 || buf.readUInt16LE(local + 8) !== method || buf.readUInt16LE(local + 6) !== flags) throw new Error("Invalid local ZIP header");
    const ln = buf.readUInt16LE(local + 26), le = buf.readUInt16LE(local + 28), start = local + 30 + ln + le;
    bounds(local + 30, ln + le); bounds(start, compressed);
    if (!buf.subarray(local + 30, local + 30 + ln).equals(nameBytes) || start + compressed > cdEnd - cdSize) throw new Error("ZIP local entry mismatch");
    if (size > limits.maxBytes - total) throw new Error("ZIP expanded data exceeds maxTransferBytes");
    const payload = buf.subarray(start, start + compressed);
    if (method === 0 && compressed !== size) throw new Error("Invalid stored ZIP size");
    const data = method === 0 ? Buffer.from(payload) : await inflateAsync(payload, { maxOutputLength: Math.max(1, Math.min(size, limits.maxBytes - total)) });
    if (data.length !== size || crc32(data) !== checksum) throw new Error("ZIP size/CRC integrity check failed");
    total += data.length;
    if (total > limits.maxBytes) throw new Error("ZIP expanded data exceeds maxTransferBytes");
    if (name.endsWith("/")) { if (size !== 0) throw new Error("Invalid ZIP directory content"); continue; }
    out.push({ name, data });
  }
  const fileNames = new Set(out.map(entry => {
    const name = entry.name.split("/").filter(part => part && part !== ".").join("/");
    return process.platform === "win32" ? name.toLowerCase() : name;
  }));
  for (const name of fileNames) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (fileNames.has(parts.slice(0, i).join("/"))) throw new Error("ZIP file/directory destination conflict");
    }
  }
  if (cd !== cdEnd) throw new Error("Central directory size mismatch");
  if (limits.signal?.aborted) throw new Error("File operation aborted");
  return out;
}
