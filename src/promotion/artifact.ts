// Two different digests bind the source artifact, and they are not interchangeable:
//   archive_digest          = sha256 of the zip archive bytes as GitHub Actions stores them
//                             (Actions API `artifact.digest`; compared to real bytes when
//                             --archive-path is given). Identifies the transport container.
//   content_manifest_digest = JCS sha256 of the static-site content manifest recomputed from
//                             the extracted files (src/manifest/manifest.ts canonical form) --
//                             must equal the sealed bundle's static_site artifacts[].digest.
//                             Identifies what the site actually serves.
// The site is extracted outside the CLI (the workflow extracts with actions/download-artifact and
// passes --site-dir). The evidence artifact is NOT: its zip bytes are matched against the Actions
// API digest and receipt.json / bundle.json are read from those same bytes (zip.ts).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Bundle, BundleArtifact } from "../core/types.js";
import { buildManifest, readBackVerify } from "../manifest/manifest.js";
import { PromotionError } from "./types.js";

export function sha256Buffer(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function sha256File(filePath: string): string {
  return sha256Buffer(readFileSync(filePath));
}

/** The sealed bundle's single static_site artifact (exactly one, or exit 3). */
export function staticSiteArtifact(bundle: Bundle): BundleArtifact {
  const sites = bundle.artifacts.filter((a) => a.kind === "static_site");
  if (sites.length !== 1) {
    throw new PromotionError(
      3,
      `bundle must carry exactly one static_site artifact, has ${sites.length}`,
    );
  }
  return sites[0] as BundleArtifact;
}

/** Compares archive bytes on disk with the provider-reported archive digest. */
export function verifyArchive(archivePath: string, expectedArchiveDigest: string): string {
  const actual = sha256File(archivePath);
  if (actual !== expectedArchiveDigest) {
    throw new PromotionError(
      3,
      `archive ${archivePath} hashes to ${actual}, provider reports ${expectedArchiveDigest}`,
    );
  }
  return actual;
}

/** Reads the archive once and checks those bytes against the provider-reported archive digest;
 * the returned bytes are the ones that were hashed (no second read of the file). */
export function readVerifiedArchive(
  archivePath: string,
  expectedArchiveDigest: string,
): { digest: string; bytes: Buffer } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(archivePath);
  } catch (err) {
    throw new PromotionError(2, `cannot read archive ${archivePath}: ${(err as Error).message}`);
  }
  const digest = sha256Buffer(bytes);
  if (digest !== expectedArchiveDigest) {
    throw new PromotionError(
      3,
      `archive ${archivePath} hashes to ${digest}, provider reports ${expectedArchiveDigest}`,
    );
  }
  return { digest, bytes };
}

/** Recomputes the content manifest of the extracted site and checks it against the sealed
 * bundle: content root digest == artifact.digest, and the site's own release-manifest.json is
 * consistent with the files AND its bytes hash to artifact.content_manifest_digest. Returns the
 * content manifest digest recorded in the ledger. */
export function verifySiteContent(siteDir: string, artifact: BundleArtifact): string {
  const { digest } = buildManifest(siteDir);
  if (digest !== artifact.digest) {
    throw new PromotionError(
      3,
      `site content manifest ${digest} does not match sealed static_site digest ${artifact.digest}`,
    );
  }
  const back = readBackVerify(siteDir, artifact.digest);
  if (!back.ok) {
    throw new PromotionError(3, "site release-manifest.json is inconsistent", {
      problems: back.problems,
    });
  }
  if (
    artifact.content_manifest_digest &&
    back.contentManifestDigest !== artifact.content_manifest_digest
  ) {
    throw new PromotionError(
      3,
      `release-manifest.json bytes ${back.contentManifestDigest} != sealed content_manifest_digest ${artifact.content_manifest_digest}`,
    );
  }
  return digest;
}
