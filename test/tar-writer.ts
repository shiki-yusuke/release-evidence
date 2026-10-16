// Test-only tar writer: builds `artifact.tar` archives for src/promotion/tar.ts, including
// deliberately broken ones (every header field can be overridden).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface TarEntrySpec {
  name: string;
  /** Raw name field bytes (instead of the UTF-8 encoded `name`). */
  nameBytes?: Buffer;
  /** Entry data; any typeflag carries it (e.g. a hand-made "L" / "x" / "g" header body). */
  data?: Buffer | string;
  /** typeflag (default "0"; "5" = directory, "2" = symlink, "1" = hard link, "L" / "x" / "g"
   * / "K" = raw meta headers, ...). */
  type?: string;
  linkname?: string;
  /** GNU magic ("ustar  \0") instead of POSIX ("ustar\0" "00"). */
  gnu?: boolean;
  /** POSIX prefix field. */
  prefix?: string;
  /** Emits a GNU 'L' long-name header carrying the name (header name field truncated). */
  longName?: boolean;
  /** Emits a pax 'x' header with these records (e.g. { path: "..." }). */
  pax?: Record<string, string>;
  /** Added to the computed checksum (non-zero = corrupt header). */
  checksumDelta?: number;
}

export interface TarOptions {
  /** Number of zero end blocks (default 2). */
  endBlocks?: number;
  /** Bytes appended after the end blocks. */
  trailer?: Buffer;
}

function header(spec: {
  name: string;
  nameBytes?: Buffer | undefined;
  size: number;
  type: string;
  linkname?: string;
  gnu?: boolean;
  prefix?: string;
  checksumDelta?: number;
}): Buffer {
  const h = Buffer.alloc(512);
  if (spec.nameBytes) spec.nameBytes.copy(h, 0, 0, 100);
  else h.write(spec.name.slice(0, 100), 0, "utf-8");
  h.write("0000644\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write(`${spec.size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write(spec.type, 156, "latin1");
  if (spec.linkname) h.write(spec.linkname, 157, "utf-8");
  if (spec.gnu) h.write("ustar  \0", 257, "latin1");
  else h.write("ustar\u000000", 257, "latin1");
  if (spec.prefix && !spec.gnu) h.write(spec.prefix, 345, "utf-8");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  sum += spec.checksumDelta ?? 0;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return h;
}

function padded(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

export function paxRecords(records: Record<string, string>): Buffer {
  return Buffer.concat(
    Object.entries(records).map(([k, v]) => {
      const body = ` ${k}=${v}\n`;
      let len = Buffer.byteLength(body) + 1;
      while (String(len).length + Buffer.byteLength(body) !== len) len++;
      return Buffer.from(`${len}${body}`, "utf-8");
    }),
  );
}

export function buildTar(entries: TarEntrySpec[], opts: TarOptions = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? "0";
    const data = Buffer.from(e.data ?? "");
    if (e.pax) {
      const body = paxRecords(e.pax);
      parts.push(header({ name: "PaxHeader", size: body.length, type: "x" }), padded(body));
    }
    if (e.longName) {
      const body = Buffer.from(`${e.name}\0`, "utf-8");
      parts.push(header({ name: "././@LongLink", size: body.length, type: "L", gnu: true }));
      parts.push(padded(body));
    }
    parts.push(
      header({
        name: e.name,
        nameBytes: e.nameBytes,
        size: data.length,
        type,
        ...(e.linkname !== undefined ? { linkname: e.linkname } : {}),
        ...(e.gnu || e.longName ? { gnu: true } : {}),
        ...(e.prefix !== undefined ? { prefix: e.prefix } : {}),
        ...(e.checksumDelta !== undefined ? { checksumDelta: e.checksumDelta } : {}),
      }),
    );
    if (data.length > 0) parts.push(padded(data));
  }
  parts.push(Buffer.alloc(512 * (opts.endBlocks ?? 2)));
  if (opts.trailer) parts.push(opts.trailer);
  return Buffer.concat(parts);
}

/** `tar -C dir -cf - .` in the shape upload-pages-artifact produces ("./" root, "./" prefixes). */
export function tarOfDir(dir: string): Buffer {
  const entries: TarEntrySpec[] = [{ name: "./", type: "5" }];
  const walk = (abs: string, rel: string) => {
    for (const d of readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const r = `${rel}${d.name}`;
      if (d.isDirectory()) {
        entries.push({ name: `./${r}/`, type: "5" });
        walk(path.join(abs, d.name), `${r}/`);
      } else {
        entries.push({ name: `./${r}`, data: readFileSync(path.join(abs, d.name)) });
      }
    }
  };
  walk(dir, "");
  return buildTar(entries);
}
