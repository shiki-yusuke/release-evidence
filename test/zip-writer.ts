// Test-only ZIP writer: builds archives for src/promotion/zip.ts, including deliberately broken
// ones. Deflate comes from node:zlib; the container (local headers, central directory, EOCD) is
// written here so each field can be overridden independently.

import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/promotion/zip.js";

export interface ZipEntrySpec {
  name: string;
  data: Buffer | string;
  /** 0 = stored, 8 = deflate (default). */
  method?: number;
  /** Extra general-purpose flags OR'ed into both headers (1 = encrypted, 0x40 = strong). */
  flags?: number;
  /** Unix mode; sets the "made by" host to unix and the high 16 bits of external attributes. */
  unixMode?: number;
  /** Streaming style: flag bit 3, zero crc/sizes in the local header, data descriptor after. */
  descriptor?: boolean;
  /** Overrides of the declared values (both headers unless noted). */
  crc?: number;
  size?: number;
  localName?: string;
  localCrc?: number;
}

export interface ZipOptions {
  /** Marks the EOCD with zip64 sentinels (0xffffffff central directory offset/size). */
  zip64?: boolean;
}

function header(fields: Array<[number, 2 | 4]>): Buffer {
  const buf = Buffer.alloc(fields.reduce((n, [, w]) => n + w, 0));
  let at = 0;
  for (const [v, w] of fields) {
    if (w === 2) buf.writeUInt16LE(v, at);
    else buf.writeUInt32LE(v >>> 0, at);
    at += w;
  }
  return buf;
}

export function buildZip(entries: ZipEntrySpec[], opts: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf-8");
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const flags = 0x0800 | (e.flags ?? 0) | (e.descriptor ? 0x0008 : 0);
    const name = Buffer.from(e.name, "utf-8");
    const localName = Buffer.from(e.localName ?? e.name, "utf-8");
    const lCrc = e.descriptor ? 0 : (e.localCrc ?? crc);
    const lCsize = e.descriptor ? 0 : body.length;
    const lSize = e.descriptor ? 0 : size;
    const local = Buffer.concat([
      header([
        [0x04034b50, 4],
        [20, 2],
        [flags, 2],
        [method, 2],
        [0, 2],
        [0x21, 2],
        [lCrc, 4],
        [lCsize, 4],
        [lSize, 4],
        [localName.length, 2],
        [0, 2],
      ]),
      localName,
      body,
      e.descriptor
        ? header([
            [0x08074b50, 4],
            [crc, 4],
            [body.length, 4],
            [size, 4],
          ])
        : Buffer.alloc(0),
    ]);
    const madeBy = e.unixMode !== undefined ? (3 << 8) | 20 : 20;
    const external = e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : 0;
    centrals.push(
      Buffer.concat([
        header([
          [0x02014b50, 4],
          [madeBy, 2],
          [20, 2],
          [flags, 2],
          [method, 2],
          [0, 2],
          [0x21, 2],
          [crc, 4],
          [body.length, 4],
          [size, 4],
          [name.length, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [0, 2],
          [external, 4],
          [offset, 4],
        ]),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = header([
    [0x06054b50, 4],
    [0, 2],
    [0, 2],
    [entries.length, 2],
    [entries.length, 2],
    [opts.zip64 ? 0xffffffff : cd.length, 4],
    [opts.zip64 ? 0xffffffff : offset, 4],
    [0, 2],
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}
