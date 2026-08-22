// static_site content manifest: canonical form defined normatively in
// docs/protocols/release-evidence-v0.md's "Static-site content manifest" section. A single
// JSON object mapping each file's path (relative, POSIX-separated, NFC, no "." or ".."
// segments, no leading slash) to "sha256:<hex>" of its bytes, excluding release-manifest.json
// itself (it cannot contain its own digest). Symlinks are not followed -- a site that needs
// them fails preparation, per the protocol.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * contain its own digest. */
export function buildManifest(dir: string): BuildManifestResult {
  const absoluteFiles: string[] = [];
  collectFiles(dir, dir, absoluteFiles);

  const manifest: ContentManifest = {};
  for (const abs of absoluteFiles) {
    const relative = toCanonicalRelativePath(dir, abs);
    if (relative === MANIFEST_FILENAME) continue;
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

/** Path-only read-back verification (the URL-fetch variant is left for the first real deploy
 * adapter, per the task's scope note): reads dir/release-manifest.json back off disk, and
 * checks its recorded `content` against a manifest rebuilt directly from the files present in
 * `dir` right now -- the same "digest is checked against the real bundle" discipline the
 * protocol applies to release events, applied here to a deployed site. */
export function readBackVerify(dir: string): ReadBackVerifyResult {
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

  let parsed: { schema_version?: string; bundle_digest?: string; content?: ContentManifest };
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

  const problems: string[] = [];
  const recorded = parsed.content ?? {};
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

  return {
    ok: problems.length === 0,
    problems,
    contentManifestDigest,
    bundleDigest: parsed.bundle_digest ?? null,
  };
}
