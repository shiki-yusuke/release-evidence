import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest, readBackVerify, writeReleaseManifest } from "../src/manifest/manifest.js";

function sha256(buf: Buffer | string): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

describe("buildManifest", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-evidence-manifest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps relative POSIX paths to sha256 digests, including nested files", () => {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");

    const { manifest } = buildManifest(dir);

    expect(manifest["index.html"]).toBe(sha256("<html></html>"));
    expect(manifest["assets/app.js"]).toBe(sha256("console.log(1)"));
    expect(Object.keys(manifest).sort()).toEqual(["assets/app.js", "index.html"]);
  });

  it("excludes release-manifest.json itself", () => {
    writeFileSync(path.join(dir, "index.html"), "hi");
    writeFileSync(
      path.join(dir, "release-manifest.json"),
      JSON.stringify({ schema_version: "release-evidence/v0" }),
    );

    const { manifest } = buildManifest(dir);

    expect(Object.keys(manifest)).toEqual(["index.html"]);
  });

  it("NFC-normalizes file names", () => {
    // Built explicitly from code points rather than typed as a literal, so the source
    // file's own text encoding can't accidentally normalize this before the test even
    // runs: "e" + combining acute accent (U+0301) is the NFD form of the letter with an
    // acute accent.
    const nfd = "cafe\u0301.txt";
    const nfc = nfd.normalize("NFC");
    writeFileSync(path.join(dir, nfd), "content");

    const { manifest } = buildManifest(dir);

    expect(Object.keys(manifest)).toEqual([nfc]);
  });

  it("throws on a symlink rather than following it", () => {
    writeFileSync(path.join(dir, "real.txt"), "content");
    symlinkSync(path.join(dir, "real.txt"), path.join(dir, "link.txt"));

    expect(() => buildManifest(dir)).toThrow(/symlink/);
  });

  it("computes a digest that is the sha256 of the manifest's JCS bytes, independent of key insertion order", async () => {
    writeFileSync(path.join(dir, "a.txt"), "a");
    writeFileSync(path.join(dir, "b.txt"), "b");
    const built = buildManifest(dir);

    const { canonicalize, sha256hex } = await import("#vendor/jcs.mjs");
    expect(built.digest).toBe(`sha256:${sha256hex(canonicalize(built.manifest))}`);

    // Same logical mapping, different key insertion order -- JCS sorts keys, so the digest
    // must be identical regardless of how the object was constructed.
    const reordered = { "b.txt": built.manifest["b.txt"], "a.txt": built.manifest["a.txt"] };
    expect(sha256hex(canonicalize(reordered))).toBe(sha256hex(canonicalize(built.manifest)));
  });
});

describe("writeReleaseManifest + readBackVerify", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-evidence-manifest-rw-"));
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips: what's written verifies clean, and its own digest is stable", () => {
    const { manifest } = buildManifest(dir);
    const bundleDigest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const written = writeReleaseManifest(dir, bundleDigest, manifest);

    const result = readBackVerify(dir);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.contentManifestDigest).toBe(written.digest);
    expect(result.bundleDigest).toBe(bundleDigest);
  });

  it("detects drift when a file changes on disk after the manifest was written", () => {
    const { manifest } = buildManifest(dir);
    writeReleaseManifest(
      dir,
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      manifest,
    );

    writeFileSync(path.join(dir, "index.html"), "<html>tampered</html>");

    const result = readBackVerify(dir);

    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.startsWith("file_digest_mismatch:") || p.startsWith("content_digest_mismatch:"),
      ),
    ).toBe(true);
  });

  it("reports a missing manifest cleanly", () => {
    const result = readBackVerify(dir);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/cannot read/);
  });
});
