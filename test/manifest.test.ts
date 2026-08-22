import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("throws when the root itself is a symlink", () => {
    const real = mkdtempSync(path.join(tmpdir(), "release-evidence-manifest-real-"));
    writeFileSync(path.join(real, "index.html"), "hi");
    const linkRoot = path.join(dir, "site-link");
    symlinkSync(real, linkRoot);

    expect(() => buildManifest(linkRoot)).toThrow(/symlink/);

    rmSync(real, { recursive: true, force: true });
  });

  it("does not silently drop a file literally named __proto__", () => {
    writeFileSync(path.join(dir, "__proto__"), "gotcha");

    const { manifest } = buildManifest(dir);

    expect(Object.keys(manifest)).toEqual(["__proto__"]);
    expect(manifest.__proto__).toBe(sha256("gotcha"));
  });

  it("rejects two files that canonicalize to the same NFC path (NFC/NFD collision)", () => {
    // Two byte-different filenames that normalize to the identical NFC string: "e" +
    // combining acute accent (U+0301, NFD) vs the single precomposed codepoint (NFC).
    // Written explicitly from code points -- see the NFC-normalizes test above for why a
    // literal in this file can't be trusted to stay in one normal form.
    const nfd = "cafe\u0301.txt";
    const nfc = nfd.normalize("NFC");
    writeFileSync(path.join(dir, nfd), "one");
    writeFileSync(path.join(dir, nfc), "two");

    // Some filesystems (notably macOS APFS) treat NFC/NFD forms of the same name as the SAME
    // directory entry -- the second write above then just overwrites the first rather than
    // creating a second file, so there is nothing for buildManifest to collide on. The
    // collision-rejection code path this test exercises still matters on filesystems that DO
    // keep them as two distinct entries (most Linux filesystems, e.g. CI): only assert the
    // throw when the filesystem actually gave us two entries to collide.
    const entryCount = readdirSync(dir).length;
    if (entryCount < 2) {
      console.warn(
        "this filesystem collapsed the NFC/NFD pair into one directory entry -- skipping the collision assertion here (nothing to collide on)",
      );
      return;
    }
    expect(() => buildManifest(dir)).toThrow(/canonicalize to the same path/);
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
    const built = buildManifest(dir);
    const written = writeReleaseManifest(dir, built.manifest);

    const result = readBackVerify(dir);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.contentManifestDigest).toBe(written.digest);
    // contentDigest is JCS-sha256(content) -- must equal buildManifest's own digest for the
    // exact same file set (this IS the value a static_site artifact's `digest` should carry).
    expect(result.contentDigest).toBe(built.digest);
  });

  it("detects drift when a file changes on disk after the manifest was written", () => {
    const { manifest } = buildManifest(dir);
    writeReleaseManifest(dir, manifest);

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

  it("rejects a wrapper with the wrong schema_version even when content matches", () => {
    const { manifest } = buildManifest(dir);
    writeFileSync(
      path.join(dir, "release-manifest.json"),
      JSON.stringify({ schema_version: "something-else/v9", content: manifest }),
    );

    const result = readBackVerify(dir);

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith("schema_version_mismatch:"))).toBe(true);
  });

  it("rejects the old bundle_digest-embedding format outright (playbook PR #13 removed it)", () => {
    const { manifest } = buildManifest(dir);
    writeFileSync(
      path.join(dir, "release-manifest.json"),
      JSON.stringify({
        schema_version: "release-evidence/v0",
        bundle_digest: `sha256:${"a".repeat(64)}`,
        content: manifest,
      }),
    );

    const result = readBackVerify(dir);

    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.startsWith("unknown_wrapper_key:") && p.includes("bundle_digest"),
      ),
    ).toBe(true);
  });

  it("rejects any other unexpected top-level key too", () => {
    const { manifest } = buildManifest(dir);
    writeFileSync(
      path.join(dir, "release-manifest.json"),
      JSON.stringify({ schema_version: "release-evidence/v0", content: manifest, extra: "nope" }),
    );

    const result = readBackVerify(dir);

    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.startsWith("unknown_wrapper_key:") && p.includes("extra")),
    ).toBe(true);
  });

  it("rejects a content digest that does not match the expected value", () => {
    const { manifest } = buildManifest(dir);
    const expected = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; // deliberately wrong
    writeReleaseManifest(dir, manifest);

    const result = readBackVerify(dir, expected);

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith("expected_content_digest_mismatch:"))).toBe(
      true,
    );
  });

  it("passes when the content digest matches the expected value", () => {
    const built = buildManifest(dir);
    writeReleaseManifest(dir, built.manifest);

    expect(readBackVerify(dir, built.digest).ok).toBe(true);
  });

  it("rejects content that isn't an object (null, array, or scalar)", () => {
    const casesContent: unknown[] = [null, [], "not-an-object", 42];
    for (const content of casesContent) {
      writeFileSync(
        path.join(dir, "release-manifest.json"),
        JSON.stringify({ schema_version: "release-evidence/v0", content }),
      );
      const result = readBackVerify(dir);
      expect(result.ok).toBe(false);
      expect(result.problems.some((p) => p.startsWith("content_not_an_object:"))).toBe(true);
    }
  });
});
