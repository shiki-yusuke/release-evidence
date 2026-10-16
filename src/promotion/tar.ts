// Minimal, strict reader for the uncompressed `artifact.tar` that actions/upload-pages-artifact
// puts inside the Pages artifact zip (no dependency). It accepts exactly what is needed to
// attribute every served byte to one path, and refuses anything else:
//   512-byte headers with a valid checksum and ustar magic (POSIX "ustar\0" "00" or GNU
//   "ustar " " \0"); POSIX prefix + name; GNU long names (typeflag 'L'); pax extended headers
//   (typeflag 'x') whose only meaningful key is `path` (time / owner keys are ignored, any other
//   key or a repeated key is refused); regular files ('0' / '\0') and directories ('5') only --
//   symlinks, hard links, devices, fifos and unknown typeflags are refused.
//   Names: every entry has exactly one name source, so no decoder can read another path for it.
//   Precedence would be pax `path` > GNU long name > ustar prefix/name, but an entry carrying
//   BOTH an 'L' and a pax `path` is refused instead of resolved. Also refused: pax global
//   headers ('g'), GNU long link names ('K'), two 'L' (or two 'x') headers for one entry, and an
//   'L' / 'x' not followed by a regular file or directory entry. Names are strict UTF-8 (the
//   decoder keeps a leading BOM) and a name containing U+FEFF is refused.
//   Paths: leading "./" is dropped; absolute paths, backslashes, NUL, empty or ".." segments,
//   duplicates (after normalization) and a file used as a parent directory are refused.
//   Sizes: octal only (base-256 refused), data must fit in the archive; the archive must end
//   with two zero blocks followed by nothing but zero bytes.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export class TarError extends Error {}

const BLOCK = 512;

export interface TarEntry {
  path: string;
  type: "file" | "directory";
  data: Buffer;
}

function fail(msg: string): never {
  throw new TarError(`tar: ${msg}`);
}

function cstring(buf: Buffer, start: number, len: number): Buffer {
  const field = buf.subarray(start, start + len);
  const nul = field.indexOf(0);
  return nul === -1 ? field : field.subarray(0, nul);
}

function utf8(raw: Buffer, what: string): string {
  try {
    // ignoreBOM: a leading EF BB BF stays in the name (and is refused) instead of being dropped.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    fail(`${what} is not valid UTF-8`);
  }
}

function octal(buf: Buffer, start: number, len: number, what: string): number {
  const field = buf.subarray(start, start + len);
  if (((field[0] as number) & 0x80) !== 0) fail(`${what}: base-256 numbers are not supported`);
  const text = field
    .toString("latin1")
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) fail(`${what}: not an octal number (${JSON.stringify(text)})`);
  const n = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(n)) fail(`${what}: out of range`);
  return n;
}

function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8, "checksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] as number);
  return sum === stored;
}

function isZero(buf: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (buf[i] !== 0) return false;
  return true;
}

/** Normalizes an entry path (see header); "" = the archive root directory. */
function normalizePath(raw: string, isDir: boolean): string {
  if (raw.length === 0) fail("empty entry name");
  if (raw.includes("\0")) fail(`entry name contains NUL: ${JSON.stringify(raw)}`);
  if (raw.includes("\uFEFF")) fail(`entry name contains U+FEFF (BOM): ${JSON.stringify(raw)}`);
  if (raw.includes("\\")) fail(`entry name contains a backslash: ${JSON.stringify(raw)}`);
  if (raw.startsWith("/")) fail(`entry name is absolute: ${JSON.stringify(raw)}`);
  let p = raw;
  if (isDir) p = p.replace(/\/+$/, "");
  else if (p.endsWith("/")) fail(`file entry name ends with "/": ${JSON.stringify(raw)}`);
  const segments = p.length === 0 ? [] : p.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "..") fail(`entry name contains "..": ${JSON.stringify(raw)}`);
    if (seg === "." && out.length === 0) continue; // leading "./" (tar -C dir .)
    if (seg === "" || seg === ".") fail(`entry name has an empty or "." segment: ${raw}`);
    out.push(seg);
  }
  return out.join("/");
}

const IGNORED_PAX_KEYS = new Set([
  "atime",
  "ctime",
  "mtime",
  "uid",
  "gid",
  "uname",
  "gname",
  "charset",
  "comment",
]);

/** Parses pax records (`<len> <key>=<value>\n`); returns the `path` value if present. */
function paxPath(data: Buffer): string | undefined {
  let at = 0;
  let found: string | undefined;
  const keys = new Set<string>();
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) fail("pax record without a length");
    const lenText = data.subarray(at, space).toString("latin1");
    if (!/^[1-9][0-9]*$/.test(lenText)) fail(`pax record length ${JSON.stringify(lenText)}`);
    const len = Number(lenText);
    const end = at + len;
    if (end > data.length || data[end - 1] !== 0x0a) fail("pax record overruns its header");
    const record = utf8(data.subarray(space + 1, end - 1), "pax record");
    const eq = record.indexOf("=");
    if (eq <= 0) fail("pax record without a key");
    const key = record.slice(0, eq);
    if (keys.has(key)) fail(`pax key ${JSON.stringify(key)} repeated`);
    keys.add(key);
    if (key === "path") found = record.slice(eq + 1);
    else if (!IGNORED_PAX_KEYS.has(key)) fail(`unsupported pax key ${JSON.stringify(key)}`);
    at = end;
  }
  return found;
}

/** Reads and validates the whole archive (see header); `limit` caps the summed file sizes. */
export function readTar(buf: Buffer, limit = Number.MAX_SAFE_INTEGER): TarEntry[] {
  if (buf.length % BLOCK !== 0) fail(`archive length ${buf.length} is not a multiple of 512`);
  const entries: TarEntry[] = [];
  const seen = new Map<string, TarEntry["type"]>();
  const nfc = new Set<string>();
  /** every ancestor directory of an entry seen so far (implicit or explicit). */
  const dirs = new Set<string>();
  let total = 0;
  /** name carried by a pending 'L' / 'x' header; `undefined` = no such header pending. */
  let longName: string | undefined;
  let pax: { path: string | undefined } | undefined;
  let at = 0;
  for (;;) {
    if (at + BLOCK > buf.length) fail("archive ends without the two zero end blocks");
    if (isZero(buf, at, at + BLOCK)) {
      if (longName !== undefined || pax !== undefined) {
        fail("'L' / 'x' header is not followed by an entry");
      }
      if (at + 2 * BLOCK > buf.length || !isZero(buf, at + BLOCK, at + 2 * BLOCK)) {
        fail("single zero block where the end of archive (two zero blocks) was expected");
      }
      if (!isZero(buf, at + 2 * BLOCK, buf.length)) fail("data after the end of archive");
      return entries;
    }
    const headerAt = at;
    const header = buf.subarray(at, at + BLOCK);
    if (!checksumOk(header)) fail(`header checksum mismatch at offset ${at}`);
    const magic = header.subarray(257, 265).toString("latin1");
    const posix = magic === "ustar\u000000";
    if (!posix && magic !== "ustar  \u0000") fail(`unsupported header format at offset ${at}`);
    const size = octal(header, 124, 12, "size");
    const typeflag = String.fromCharCode(header[156] as number);
    const dataStart = at + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) fail(`entry data overruns the archive at offset ${at}`);
    const data = buf.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === "g") fail(`pax global header at offset ${headerAt}`);
    if (typeflag === "K") fail(`GNU long link name at offset ${headerAt}`);
    if (typeflag === "L") {
      if (longName !== undefined) fail(`two 'L' headers for one entry at offset ${headerAt}`);
      longName = utf8(cstring(data, 0, data.length), "GNU long name");
    } else if (typeflag === "x") {
      if (pax !== undefined) fail(`two 'x' headers for one entry at offset ${headerAt}`);
      pax = { path: paxPath(data) };
    }
    if (longName !== undefined && pax?.path !== undefined) {
      fail(`entry has both a GNU long name and a pax path at offset ${headerAt}`);
    }
    if (typeflag === "L" || typeflag === "x") continue;
    const isFile = typeflag === "0" || typeflag === "\0";
    if (!isFile && typeflag !== "5") {
      const after = longName !== undefined || pax !== undefined ? " after an 'L' / 'x' header" : "";
      fail(`unsupported entry type ${JSON.stringify(typeflag)}${after} at offset ${headerAt}`);
    }
    let raw = utf8(cstring(header, 0, 100), "entry name");
    if (posix) {
      const prefix = utf8(cstring(header, 345, 155), "entry name prefix");
      if (prefix.length > 0) raw = `${prefix}/${raw}`;
    }
    raw = pax?.path ?? longName ?? raw;
    pax = undefined;
    longName = undefined;
    const p = normalizePath(raw, !isFile);
    if (!isFile && size !== 0) fail(`directory ${JSON.stringify(raw)} has a size`);
    if (p.length === 0) {
      if (isFile) fail("file entry with an empty path");
      continue; // the root directory itself ("./")
    }
    if (seen.has(p) || nfc.has(p.normalize("NFC"))) fail(`duplicate entry path: ${p}`);
    nfc.add(p.normalize("NFC"));
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join("/")) === "file") fail(`file used as a directory: ${p}`);
    }
    const type = isFile ? "file" : "directory";
    if (isFile) {
      if (dirs.has(p)) fail(`file used as a directory: ${p}`);
      total += size;
      if (total > limit) fail(`archive files exceed ${limit} bytes`);
    }
    seen.set(p, type);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    entries.push({ path: p, type, data: Buffer.from(data) });
  }
}

/** Writes the entries into a fresh temporary directory, runs `fn` on it, and always removes it. */
export function withExtractedTar<T>(entries: TarEntry[], fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-pages-"));
  try {
    for (const e of entries) {
      const abs = path.join(dir, ...e.path.split("/"));
      if (e.type === "directory") mkdirSync(abs, { recursive: true });
      else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, e.data, { flag: "wx" });
      }
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
