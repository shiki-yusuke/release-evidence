// Evidence attribution through the zip itself (implementation review round 2, high): authorize
// takes the release-evidence-out zip, matches its sha256 with the Actions API artifact digest and
// reads bundle.json / receipt.json from those bytes. Each test here fails against the pre-fix
// code (which read an extracted directory and treated the archive as optional).

import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPromote } from "../src/promotion/commands.js";
import { EXIT } from "../src/promotion/types.js";
import { MAX_ENTRY_BYTES, ZipError, crc32, extractZipEntries } from "../src/promotion/zip.js";
import {
  RUN_ID,
  type Sandbox,
  authorizeFlags,
  deps,
  evidenceZip,
  makeApproval,
  makeSandbox,
  remoteLedger,
  writeAuthority,
  writeEvidenceArchive,
} from "./promotion-fixtures.js";
import { type ZipEntrySpec, buildZip } from "./zip-writer.js";

vi.setConfig({ testTimeout: 60_000 });

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const sb of sandboxes.splice(0)) rmSync(sb.root, { recursive: true, force: true });
});

function sandboxWithApproval() {
  const sb = makeSandbox();
  sandboxes.push(sb);
  const approval = makeApproval({ subject: sb.subject });
  writeAuthority(sb, [approval]);
  return { sb, flags: authorizeFlags(sb, approval.event_id) };
}

const BUNDLE = '{"b":1}';
const RECEIPT = '{"r":2}';
const ok = (over: Partial<ZipEntrySpec> = {}, receipt: Partial<ZipEntrySpec> = {}) =>
  buildZip([
    { name: "bundle.json", data: BUNDLE, ...over },
    { name: "receipt.json", data: RECEIPT, ...receipt },
  ]);
const NAMES = ["bundle.json", "receipt.json"];
const refuses = (zip: Buffer, re: RegExp, limit?: number) => {
  expect(() => extractZipEntries(zip, NAMES, limit)).toThrow(ZipError);
  expect(() => extractZipEntries(zip, NAMES, limit)).toThrow(re);
};

describe("zip reader", () => {
  it("crc32 matches the reference value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("reads stored and deflate entries, and streaming entries with data descriptors", () => {
    for (const zip of [
      ok({ method: 0 }, { method: 0 }),
      ok({ method: 8 }, { method: 8 }),
      ok({ method: 8, descriptor: true }, { method: 0, descriptor: true }),
    ]) {
      const files = extractZipEntries(zip, NAMES);
      expect(files.get("bundle.json")?.toString()).toBe(BUNDLE);
      expect(files.get("receipt.json")?.toString()).toBe(RECEIPT);
    }
  });

  it("refuses an archive without top-level receipt.json (nested one does not count)", () => {
    refuses(buildZip([{ name: "bundle.json", data: BUNDLE }]), /no top-level receipt\.json/);
    refuses(
      buildZip([
        { name: "bundle.json", data: BUNDLE },
        { name: "out/receipt.json", data: RECEIPT },
      ]),
      /no top-level receipt\.json/,
    );
  });

  it("refuses zip64", () => {
    refuses(buildZip([{ name: "bundle.json", data: BUNDLE }], { zip64: true }), /zip64/);
  });

  it("refuses encrypted entries (traditional and strong)", () => {
    refuses(ok({ flags: 0x0001 }), /encrypted/);
    refuses(ok({}, { flags: 0x0040 }), /encrypted/);
  });

  it("refuses unsafe names: .., absolute, drive letter, backslash", () => {
    for (const name of ["../receipt.json", "a/../../x", "/etc/x", "C:/x", "a\\b.json"]) {
      refuses(
        buildZip([
          { name: "bundle.json", data: BUNDLE },
          { name: "receipt.json", data: RECEIPT },
          { name, data: "x" },
        ]),
        /\.\.|absolute|backslash/,
      );
    }
  });

  it("refuses duplicate names", () => {
    refuses(
      buildZip([
        { name: "bundle.json", data: BUNDLE },
        { name: "receipt.json", data: RECEIPT },
        { name: "receipt.json", data: '{"r":"forged"}' },
      ]),
      /duplicate entry name: receipt\.json/,
    );
  });

  it("refuses symlinks", () => {
    refuses(ok({}, { unixMode: 0o120777 }), /symlink/);
    expect(() => extractZipEntries(ok({}, { unixMode: 0o100644 }), NAMES)).not.toThrow();
  });

  it("refuses CRC32 mismatch (stored and deflate)", () => {
    refuses(ok({ method: 0, crc: crc32(Buffer.from(BUNDLE)) ^ 1 }), /CRC32 mismatch: bundle/);
    refuses(ok({}, { method: 8, crc: 0x12345678 }), /CRC32 mismatch: receipt/);
  });

  it("refuses inflation beyond the declared size, and declared sizes over the limit", () => {
    refuses(ok({ method: 8, size: 3 }), /bundle\.json/);
    refuses(ok({ method: 0, size: 3 }), /stored entry sizes differ/);
    refuses(ok({ method: 8, size: BUNDLE.length + 5 }), /inflates to 7 bytes, declared 12/);
    refuses(ok(), /declares 7 bytes, limit 4/, 4);
    expect(MAX_ENTRY_BYTES).toBe(16 * 1024 * 1024);
  });

  it("refuses central directory / local header disagreement", () => {
    refuses(ok({}, { localName: "receipt.jsoN" }), /local header name differs/);
    refuses(ok({}, { localCrc: 1 }), /local header crc\/size differ/);
  });

  it("refuses a data descriptor that does not repeat the central directory (size unknown)", () => {
    const zip = ok({ method: 8, descriptor: true });
    // corrupt the descriptor's size field (descriptor = sig, crc, csize, size after the data)
    const sig = zip.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    zip.writeUInt32LE(999, sig + 12);
    refuses(zip, /data descriptor missing or inconsistent/);
  });

  it("refuses unsupported compression methods and garbage", () => {
    refuses(ok({ method: 12 }), /unsupported compression method 12/);
    refuses(Buffer.from("not a zip at all, definitely not"), /end of central directory/);
  });
});

describe("authorize reads receipt/bundle from the digest-matched zip", () => {
  it("a zip whose bundle.json was replaced (API digest unchanged) is refused", async () => {
    const { sb, flags } = sandboxWithApproval();
    const forged = evidenceZip(sb, RUN_ID, 1, { bundle: { ...sb.bundle, release_id: "x@6.6.6" } });
    writeFileSync(sb.evidenceArchivePath, forged);
    const r = await runPromote("authorize", flags, deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/hashes to .* provider reports/);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("a digest-matched zip without receipt.json is refused", async () => {
    const { sb, flags } = sandboxWithApproval();
    writeEvidenceArchive(sb, RUN_ID, 1, {
      zip: buildZip([{ name: "bundle.json", data: JSON.stringify(sb.bundle) }]),
    });
    const r = await runPromote("authorize", flags, deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/release-evidence-out-1001-1: zip: .*receipt\.json/);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("a digest-matched but structurally unsafe zip is refused before anything is parsed", async () => {
    const good = [
      { name: "bundle.json", data: "" },
      { name: "receipt.json", data: "" },
    ];
    for (const [extra, re] of [
      [{ name: "../escape", data: "x" }, /\.\./],
      [{ name: "receipt.json", data: "{}" }, /duplicate/],
    ] as const) {
      const { sb, flags } = sandboxWithApproval();
      good[0] = { name: "bundle.json", data: JSON.stringify(sb.bundle) };
      good[1] = { name: "receipt.json", data: JSON.stringify(sb.receipt) };
      writeEvidenceArchive(sb, RUN_ID, 1, { zip: buildZip([...good, extra]) });
      const r = await runPromote("authorize", flags, deps(sb));
      expect(r.exitCode).toBe(EXIT.precondition);
      expect(String(r.output.error)).toMatch(re);
      expect(remoteLedger(sb)).toEqual([]);
    }
  });

  it("a zip with deflate bundle.json and stored receipt.json authorizes", async () => {
    const { sb, flags } = sandboxWithApproval();
    const r = await runPromote("authorize", flags, deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    const auth = remoteLedger(sb)[1] as { resolved: { bundle_digest: string } };
    expect(auth.resolved.bundle_digest).toBe(sb.subject.bundle_digest);
  });
});
