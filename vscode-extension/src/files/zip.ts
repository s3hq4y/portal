/**
 * Zero-dependency ZIP support (read + write) built on zlib raw deflate.
 * Supports only STORE (0) and DEFLATE (8); no encryption, no zip64 —
 * enough for bundling workspace files.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

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
