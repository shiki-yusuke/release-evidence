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
 * to place into the site: {schema_version, content} ONLY. bundle_digest is deliberately NOT
 * embedded: the bundle carries this file's digest (content_manifest_digest), so embedding the
 * bundle's digest here would make the two mutually referential and neither computable -- the
 * circularity the first real adapter assembly exposed (playbook PR #13, 2026-08-22). The
 * site<->bundle linkage is re-derived at read-back: JCS-sha256 of `content` must equal the
 * bundle's artifacts[].digest. */
export function writeReleaseManifest(dir: string, manifest: ContentManifest): WriteManifestResult {
  const body = {
    schema_version: "release-evidence/v0",
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
  /** sha256 of the release-manifest.json bytes as read back, or null if it could not be read.
   * This is the artifact's `content_manifest_digest`. */
  contentManifestDigest: string | null;
  /** JCS-sha256 of the wrapper's `content` field, or null if `content` isn't a usable object.
   * This is what must equal a static_site artifact's `digest` -- the site<->bundle linkage the
   * old (circular) format tried to embed directly is instead re-derived here and left for the
   * caller to cross-check against the real bundle via `expectedContentDigest`. */
  contentDigest: string | null;
}

const WRAPPER_SCHEMA_VERSION = "release-evidence/v0";
/** {schema_version, content} ONLY -- no bundle_digest. A file carrying it is the pre-PR#13
 * circularly-defined format, and readBackVerify() must not silently accept it as a stricter
 * "content still happens to match" pass; that would keep validating a shape the protocol no
 * longer defines. */
const ALLOWED_WRAPPER_KEYS = new Set(["schema_version", "content"]);

/** Path-only read-back verification (the URL-fetch variant is left for the first real deploy
 * adapter, per the task's scope note): reads dir/release-manifest.json back off disk and
 * checks it three ways -- (1) the WRAPPER itself is well-formed: no keys beyond
 * {schema_version, content} (rejects the old bundle_digest-embedding format outright),
 * schema_version is the expected const, and `content` is actually an object; (2) if
 * `expectedContentDigest` is given (normally the bundle's artifacts[].digest for this
 * static_site artifact), the wrapper's own JCS-sha256(content) must equal it -- this is the
 * cross-record check that replaces the old embedded bundle_digest, done by RECOMPUTING rather
 * than trusting a stored value (sol must-2's discipline, applied here); (3) the recorded
 * `content` against a manifest rebuilt directly from the files present in `dir` right now, to
 * catch drift between what was written and what's actually deployed. */
export function readBackVerify(dir: string, expectedContentDigest?: string): ReadBackVerifyResult {
  const manifestPath = path.join(dir, MANIFEST_FILENAME);

  let bytes: Buffer;
  try {
    bytes = readFileSync(manifestPath);
  } catch (err) {
    return {
      ok: false,
      problems: [`cannot read ${manifestPath}: ${(err as Error).message}`],
      contentManifestDigest: null,
      contentDigest: null,
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
      contentDigest: null,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      problems: [`${manifestPath} does not contain a JSON object at the top level`],
      contentManifestDigest,
      contentDigest: null,
    };
  }
  const wrapper = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const unknownKeys = Object.keys(wrapper).filter((k) => !ALLOWED_WRAPPER_KEYS.has(k));
  if (unknownKeys.length > 0) {
    problems.push(
      `unknown_wrapper_key: release-manifest.json has unexpected key(s) ${unknownKeys.map((k) => JSON.stringify(k)).join(", ")} -- the current format is {schema_version, content} only; a bundle_digest here is the old, circularly-defined format (playbook PR #13 removed it)`,
    );
  }

  if (wrapper.schema_version !== WRAPPER_SCHEMA_VERSION) {
    problems.push(
      `schema_version_mismatch: expected ${JSON.stringify(WRAPPER_SCHEMA_VERSION)}, got ${JSON.stringify(wrapper.schema_version)}`,
    );
  }

  const contentIsObject =
    wrapper.content !== null &&
    typeof wrapper.content === "object" &&
    !Array.isArray(wrapper.content);
  if (!contentIsObject) {
    problems.push(
      `content_not_an_object: "content" must be a JSON object mapping paths to sha256 digests, got ${JSON.stringify(wrapper.content)}`,
    );
  }

  let contentDigest: string | null = null;
  if (contentIsObject) {
    const recorded = wrapper.content as ContentManifest;
    contentDigest = `sha256:${sha256hex(canonicalize(recorded))}`;

    if (expectedContentDigest !== undefined && contentDigest !== expectedContentDigest) {
      problems.push(
        `expected_content_digest_mismatch: content's JCS-sha256 (${contentDigest}) does not match the expected artifact digest (${expectedContentDigest})`,
      );
    }

    const rebuilt = buildManifest(dir);
    if (contentDigest !== rebuilt.digest) {
      problems.push(
        `content_digest_mismatch: release-manifest.json's recorded content (${contentDigest}) does not match the manifest rebuilt from disk (${rebuilt.digest})`,
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

  return { ok: problems.length === 0, problems, contentManifestDigest, contentDigest };
}
