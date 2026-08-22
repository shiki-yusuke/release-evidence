// static_site content manifest: canonical form defined normatively in
// docs/protocols/release-evidence-v0.md's "Static-site content manifest" section. A single
// JSON object mapping each file's path (relative, POSIX-separated, NFC, no "." or ".."
// segments, no leading slash) to "sha256:<hex>" of its bytes, excluding release-manifest.json
// itself (it cannot contain its own digest). Symlinks are not followed anywhere, including at
// the root -- a site that needs them fails preparation, per the protocol.

import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalize, sha256hex } from "#vendor/jcs.mjs";

export type ContentManifest = Record<string, string>;

const MANIFEST_FILENAME = "release-manifest.json";

function collectFiles(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `manifest build failed: "${path.relative(root, abs)}" is a symlink -- symlinks are not followed (a site that needs them fails preparation, per the protocol)`,
      );
    }
    if (entry.isDirectory()) {
      collectFiles(abs, root, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

function toCanonicalRelativePath(root: string, abs: string): string {
  const relative = path.relative(root, abs).split(path.sep).join("/").normalize("NFC");
  if (relative.startsWith("/")) {
    throw new Error(`manifest build failed: path "${relative}" has a leading slash`);
  }
  if (relative.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`manifest build failed: path "${relative}" contains a "." or ".." segment`);
  }
  return relative;
}

export interface BuildManifestResult {
  manifest: ContentManifest;
  /** sha256 over the JCS bytes of `manifest` -- this becomes the static_site artifact's
   * top-level `digest` (the content root digest, NOT a tarball digest). */
  digest: string;
}

/** Walks `dir` and builds its canonical content manifest. release-manifest.json at the root
 * (if present from a previous write) is excluded, matching the protocol's rule that it cannot
 * contain its own digest.
 *
 * The manifest object is built with `Object.create(null)` (no prototype) rather than `{}`:
 * with a plain object literal, a real on-disk file named `__proto__` silently vanishes --
 * `manifest["__proto__"] = digest` on a normal object tries to reassign the object's own
 * prototype instead of creating an own data property, so `Object.keys()` never sees it and
 * the manifest quietly under-reports the deployed file set. A null-prototype object has no
 * such accessor, so the assignment is a genuine own property like any other path.
 *
 * Two different filesystem entries can also canonicalize to the SAME path -- most commonly an
 * NFC- and an NFD-encoded form of the same visible name coexisting as distinct directory
 * entries (many filesystems don't enforce Unicode normalization uniqueness). Silently letting
 * the second one clobber the first in the manifest object would make the manifest lie about
 * which of the two files' bytes it actually attests to, so a collision is a hard error rather
 * than a last-write-wins overwrite. */
export function buildManifest(dir: string): BuildManifestResult {
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error(
      `manifest build failed: "${dir}" (the root) is a symlink -- symlinks are not followed, including at the root`,
    );
  }

  const absoluteFiles: string[] = [];
  collectFiles(dir, dir, absoluteFiles);

  const manifest: ContentManifest = Object.create(null) as ContentManifest;
  for (const abs of absoluteFiles) {
    const relative = toCanonicalRelativePath(dir, abs);
    if (relative === MANIFEST_FILENAME) continue;
    if (relative in manifest) {
      throw new Error(
        `manifest build failed: two different files canonicalize to the same path "${relative}" (e.g. an NFC/NFD Unicode collision) -- refusing to silently drop one`,
      );
    }
    manifest[relative] = `sha256:${sha256hex(readFileSync(abs))}`;
  }

  return { manifest, digest: `sha256:${sha256hex(canonicalize(manifest))}` };
}

export interface WriteManifestResult {
  path: string;
  /** sha256 of the exact bytes written to release-manifest.json -- becomes the static_site
   * artifact's `content_manifest_digest` once confirmed by a real read-back after deploy. */
  digest: string;
}

/** Writes release-manifest.json into `dir` in the form the protocol requires deploy adapters
 * to place into the site: {schema_version, bundle_digest, content}. */
export function writeReleaseManifest(
  dir: string,
  bundleDigest: string,
  manifest: ContentManifest,
): WriteManifestResult {
  const body = {
    schema_version: "release-evidence/v0",
    bundle_digest: bundleDigest,
    content: manifest,
  };
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf-8");
  const outPath = path.join(dir, MANIFEST_FILENAME);
  writeFileSync(outPath, bytes);
  return { path: outPath, digest: `sha256:${sha256hex(bytes)}` };
}

export interface ReadBackVerifyResult {
  ok: boolean;
  problems: string[];
  /** sha256 of the release-manifest.json bytes as read back, or null if it could not be read. */
  contentManifestDigest: string | null;
  bundleDigest: string | null;
}

const WRAPPER_SCHEMA_VERSION = "release-evidence/v0";
const BUNDLE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Path-only read-back verification (the URL-fetch variant is left for the first real deploy
 * adapter, per the task's scope note): reads dir/release-manifest.json back off disk and
 * checks it two ways -- (1) the WRAPPER itself is well-formed (schema_version is the expected
 * const, bundle_digest has the right shape and, if `expectedBundleDigest` is given, matches
 * it, and `content` is actually an object) before trusting anything inside it, then (2) the
 * recorded `content` against a manifest rebuilt directly from the files present in `dir` right
 * now -- the same "digest is checked against the real bundle" discipline the protocol applies
 * to release events, applied here to a deployed site. A wrapper that merely happens to have a
 * matching `content` but a wrong/missing schema_version or bundle_digest is NOT a pass: it
 * proves nothing about which release this site's manifest actually belongs to. */
export function readBackVerify(dir: string, expectedBundleDigest?: string): ReadBackVerifyResult {
  const manifestPath = path.join(dir, MANIFEST_FILENAME);

  let bytes: Buffer;
  try {
    bytes = readFileSync(manifestPath);
  } catch (err) {
    return {
      ok: false,
      problems: [`cannot read ${manifestPath}: ${(err as Error).message}`],
      contentManifestDigest: null,
      bundleDigest: null,
    };
  }
  const contentManifestDigest = `sha256:${sha256hex(bytes)}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch (err) {
    return {
      ok: false,
      problems: [`${manifestPath} is not valid JSON: ${(err as Error).message}`],
      contentManifestDigest,
      bundleDigest: null,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      problems: [`${manifestPath} does not contain a JSON object at the top level`],
      contentManifestDigest,
      bundleDigest: null,
    };
  }
  const wrapper = parsed as {
    schema_version?: unknown;
    bundle_digest?: unknown;
    content?: unknown;
  };
  const problems: string[] = [];

  if (wrapper.schema_version !== WRAPPER_SCHEMA_VERSION) {
    problems.push(
      `schema_version_mismatch: expected ${JSON.stringify(WRAPPER_SCHEMA_VERSION)}, got ${JSON.stringify(wrapper.schema_version)}`,
    );
  }

  const bundleDigestIsWellFormed =
    typeof wrapper.bundle_digest === "string" && BUNDLE_DIGEST_PATTERN.test(wrapper.bundle_digest);
  if (!bundleDigestIsWellFormed) {
    problems.push(
      `bundle_digest_malformed: ${JSON.stringify(wrapper.bundle_digest)} is not a "sha256:<64 hex>" digest`,
    );
  } else if (expectedBundleDigest !== undefined && wrapper.bundle_digest !== expectedBundleDigest) {
    problems.push(
      `bundle_digest_mismatch: release-manifest.json records ${wrapper.bundle_digest}, expected ${expectedBundleDigest}`,
    );
  }
  const bundleDigestValue =
    typeof wrapper.bundle_digest === "string" ? wrapper.bundle_digest : null;

  const contentIsObject =
    wrapper.content !== null &&
    typeof wrapper.content === "object" &&
    !Array.isArray(wrapper.content);
  if (!contentIsObject) {
    problems.push(
      `content_not_an_object: "content" must be a JSON object mapping paths to sha256 digests, got ${JSON.stringify(wrapper.content)}`,
    );
  }

  if (contentIsObject) {
    const recorded = wrapper.content as ContentManifest;
    const rebuilt = buildManifest(dir);

    const recordedDigest = `sha256:${sha256hex(canonicalize(recorded))}`;
    if (recordedDigest !== rebuilt.digest) {
      problems.push(
        `content_digest_mismatch: release-manifest.json's recorded content (${recordedDigest}) does not match the manifest rebuilt from disk (${rebuilt.digest})`,
      );
    }

    const recordedPaths = Object.keys(recorded).sort();
    const actualPaths = Object.keys(rebuilt.manifest).sort();
    if (JSON.stringify(recordedPaths) !== JSON.stringify(actualPaths)) {
      problems.push(
        `file_set_mismatch: recorded ${recordedPaths.length} path(s), disk has ${actualPaths.length} path(s) (excluding release-manifest.json itself)`,
      );
    } else {
      for (const p of recordedPaths) {
        if (recorded[p] !== rebuilt.manifest[p]) {
          problems.push(
            `file_digest_mismatch: "${p}" recorded as ${recorded[p]} but disk content hashes to ${rebuilt.manifest[p]}`,
          );
        }
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    contentManifestDigest,
    bundleDigest: bundleDigestValue,
  };
}
