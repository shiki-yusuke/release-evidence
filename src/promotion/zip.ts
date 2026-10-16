// Minimal, strict ZIP reader for the `release-evidence-out-<run_id>-<run_attempt>` artifact
// archive (no dependency: Node has inflate but no zip container reader). It reads the archive
// the way the spec lays it out -- End of central directory -> central directory -> each local
// file header -- and refuses anything it cannot attribute unambiguously:
//   zip64, encryption (traditional or strong), compression methods other than 0 (stored) and
//   8 (deflate), duplicate names, names with `..` segments / absolute paths / drive letters /
//   backslashes / NUL, symlinks (unix mode in the external attributes), central directory vs
//   local header disagreement (name, flags, method, crc, sizes), data that does not fit inside
//   the archive, inflation beyond the declared size, and CRC32 mismatch.
// Data descriptors (flag bit 3) are what streaming writers (actions/upload-artifact) emit, so they
// are accepted only when the sizes are known from the central directory, the local header's
// crc/sizes are either zero (deferred) or equal to it, and the descriptor that follows the data
// repeats exactly the central directory's crc/sizes. Anything else is "size unknown" and refused.

import { inflateRawSync } from "node:zlib";

export class ZipError extends Error {}

/** Per-entry inflate limit for the evidence files. */
export const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const HOST_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface CentralEntry {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function fail(msg: string): never {
  throw new ZipError(`zip: ${msg}`);
}

function u16(buf: Buffer, at: number): number {
  if (at + 2 > buf.length) fail(`truncated at offset ${at}`);
  return buf.readUInt16LE(at);
}

function u32(buf: Buffer, at: number): number {
  if (at + 4 > buf.length) fail(`truncated at offset ${at}`);
  return buf.readUInt32LE(at);
}

function findEocd(buf: Buffer): number {
  // EOCD is 22 bytes plus a comment of at most 0xffff bytes; the comment length must reach EOF
  // exactly, so a signature lookalike inside the comment is not taken.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let at = buf.length - 22; at >= min; at--) {
    if (buf.readUInt32LE(at) === SIG_EOCD && at + 22 + buf.readUInt16LE(at + 20) === buf.length) {
      return at;
    }
  }
  fail("end of central directory not found");
}

function checkName(raw: Buffer, utf8: boolean): string {
  let name: string;
  try {
    // ignoreBOM: a leading EF BB BF stays in the name (and is refused) instead of being dropped.
    name = new TextDecoder(utf8 ? "utf-8" : "latin1", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    fail("entry name is not valid UTF-8");
  }
  if (name.length === 0) fail("empty entry name");
  if (name.includes("\0")) fail(`entry name contains NUL: ${JSON.stringify(name)}`);
  if (name.includes("\uFEFF")) fail(`entry name contains U+FEFF (BOM): ${JSON.stringify(name)}`);
  if (name.includes("\\")) fail(`entry name contains a backslash: ${JSON.stringify(name)}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    fail(`entry name is absolute: ${JSON.stringify(name)}`);
  }
  if (name.split("/").some((seg) => seg === "..")) {
    fail(`entry name contains "..": ${JSON.stringify(name)}`);
  }
  return name;
}

function readCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEocd(buf);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR)
    fail("zip64 is not supported");
  const disk = u16(buf, eocd + 4);
  const cdDisk = u16(buf, eocd + 6);
  const entriesHere = u16(buf, eocd + 8);
  const entries = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    fail("zip64 is not supported");
  }
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries)
    fail("multi-disk archives are not supported");
  if (cdOffset + cdSize !== eocd) fail("central directory does not end at the EOCD record");

  const out: CentralEntry[] = [];
  const seen = new Set<string>();
  let at = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (u32(buf, at) !== SIG_CENTRAL) fail(`bad central directory signature at offset ${at}`);
    const madeBy = u16(buf, at + 4);
    const flags = u16(buf, at + 8);
    const method = u16(buf, at + 10);
    const crc = u32(buf, at + 16);
    const compressedSize = u32(buf, at + 20);
    const size = u32(buf, at + 24);
    const nameLen = u16(buf, at + 28);
    const extraLen = u16(buf, at + 30);
    const commentLen = u16(buf, at + 32);
    const diskStart = u16(buf, at + 34);
    const external = u32(buf, at + 38);
    const localOffset = u32(buf, at + 42);
    const end = at + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) fail("central directory entry overruns the central directory");
    const nameBytes = buf.subarray(at + 46, at + 46 + nameLen);
    const name = checkName(nameBytes, (flags & 0x0800) !== 0);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      fail(`zip64 is not supported (${name})`);
    }
    if (diskStart !== 0) fail(`multi-disk archives are not supported (${name})`);
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) fail(`encrypted entry: ${name}`);
    if (method !== 0 && method !== 8) fail(`unsupported compression method ${method}: ${name}`);
    if (madeBy >>> 8 === HOST_UNIX && ((external >>> 16) & S_IFMT) === S_IFLNK) {
      fail(`symlink entry: ${name}`);
    }
    if (seen.has(name)) fail(`duplicate entry name: ${name}`);
    seen.add(name);
    out.push({ name, nameBytes, flags, method, crc, compressedSize, size, localOffset });
    at = end;
  }
  if (at !== eocd) fail("central directory size does not match its entries");
  return out;
}

/** Validates the local header against the central entry; returns [dataStart, dataEnd). */
function locateData(buf: Buffer, e: CentralEntry, cdOffset: number): [number, number] {
  const at = e.localOffset;
  if (u32(buf, at) !== SIG_LOCAL) fail(`bad local header signature for ${e.name}`);
  const flags = u16(buf, at + 6);
  const method = u16(buf, at + 8);
  const crc = u32(buf, at + 14);
  const compressedSize = u32(buf, at + 18);
  const size = u32(buf, at + 22);
  const nameLen = u16(buf, at + 26);
  const extraLen = u16(buf, at + 28);
  if (!buf.subarray(at + 30, at + 30 + nameLen).equals(e.nameBytes)) {
    fail(`local header name differs from central directory for ${e.name}`);
  }
  if (flags !== e.flags) fail(`local header flags differ from central directory for ${e.name}`);
  if (method !== e.method) fail(`local header method differs from central directory for ${e.name}`);
  const deferred =
    (flags & FLAG_DESCRIPTOR) !== 0 && crc === 0 && compressedSize === 0 && size === 0;
  if (!deferred && (crc !== e.crc || compressedSize !== e.compressedSize || size !== e.size)) {
    fail(`local header crc/size differ from central directory for ${e.name}`);
  }
  const start = at + 30 + nameLen + extraLen;
  const end = start + e.compressedSize;
  if (end > cdOffset) fail(`entry data overruns the archive: ${e.name}`);
  if (flags & FLAG_DESCRIPTOR) {
    // Optional signature, then crc32, compressed size, size (32-bit; zip64 already refused).
    const d = buf.length >= end + 4 && buf.readUInt32LE(end) === SIG_DESCRIPTOR ? end + 4 : end;
    if (
      d + 12 > cdOffset ||
      buf.readUInt32LE(d) !== e.crc ||
      buf.readUInt32LE(d + 4) !== e.compressedSize ||
      buf.readUInt32LE(d + 8) !== e.size
    ) {
      fail(`data descriptor missing or inconsistent (size unknown): ${e.name}`);
    }
  }
  return [start, end];
}

function inflateEntry(buf: Buffer, e: CentralEntry, cdOffset: number, limit: number): Buffer {
  if (e.size > limit) fail(`${e.name} declares ${e.size} bytes, limit ${limit}`);
  const [start, end] = locateData(buf, e, cdOffset);
  const raw = buf.subarray(start, end);
  let data: Buffer;
  if (e.method === 0) {
    if (e.compressedSize !== e.size) fail(`stored entry sizes differ: ${e.name}`);
    data = Buffer.from(raw);
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
    } catch (err) {
      fail(`cannot inflate ${e.name} within its declared size: ${(err as Error).message}`);
    }
  }
  if (data.length !== e.size) {
    fail(`${e.name} inflates to ${data.length} bytes, declared ${e.size}`);
  }
  if (crc32(data) !== e.crc) fail(`CRC32 mismatch: ${e.name}`);
  return data;
}

/** Validates the whole archive structure and returns the bytes of the requested top-level
 * entries (each must exist exactly once as a file). */
export function extractZipEntries(
  archive: Buffer,
  names: readonly string[],
  limit = MAX_ENTRY_BYTES,
): Map<string, Buffer> {
  const entries = readCentralDirectory(archive);
  const cdOffset = archive.readUInt32LE(findEocd(archive) + 16);
  for (const e of entries) locateData(archive, e, cdOffset);
  const out = new Map<string, Buffer>();
  for (const name of names) {
    const e = entries.find((x) => x.name === name);
    if (!e) fail(`archive has no top-level ${name}`);
    out.set(name, inflateEntry(archive, e, cdOffset, limit));
  }
  return out;
}
