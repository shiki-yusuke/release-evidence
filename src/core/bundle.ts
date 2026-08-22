// Bundle identity (JCS sha256 digest) and validation. Mirrors checkBundle() in
// contracts/release-evidence/v0/verify-fixtures.mjs: schema + personal-dimension scan first
// (short-circuit on any failure, same as the reference), then the semantic checks the schema
// itself cannot express (array order/uniqueness is inside the digest, so it must be
// deterministic; hash-width consistency; a rollback target can't be the bundle's own release).

import { canonicalize, sha256hex } from "#vendor/jcs.mjs";
import { scanPersonalDimensions } from "#vendor/personal-dimensions.mjs";
import { createValidator } from "#vendor/schema-validator.mjs";
import { getContractsDir } from "./env.js";
import type { Bundle } from "./types.js";
import { dedupe } from "./util.js";

export type { Bundle } from "./types.js";

const BUNDLE_SCHEMA_FILE = "release-evidence-bundle.schema.json";

/** sha256 over the JCS (RFC 8785) canonical bytes of `bundle` -- the attempt identity every
 * event of this attempt carries as bundle_digest. Stable for any two calls with the same
 * bundle content regardless of key order (JCS canonicalizes keys; array order is preserved
 * and so remains normative -- see checkBundle's sorted/unique checks below). */
export function bundleDigest(bundle: unknown): string {
  return `sha256:${sha256hex(canonicalize(bundle))}`;
}

function bundleSemanticChecks(bundle: Bundle): string[] {
  const reasons: string[] = [];

  const digests = bundle.artifacts.map((a) => a.digest);
  if (new Set(digests).size !== digests.length) {
    reasons.push(
      `artifacts_not_unique: duplicate artifact digest in release_id "${bundle.release_id}"`,
    );
  }
  const sortedDigests = [...digests].sort();
  if (digests.some((d, i) => d !== sortedDigests[i])) {
    reasons.push(
      "artifacts_not_sorted: artifacts[] must be sorted ascending by digest (array order is inside the JCS digest)",
    );
  }

  const deviations = bundle.known_deviations;
  if (new Set(deviations).size !== deviations.length) {
    reasons.push("deviations_not_unique: duplicate entry in known_deviations");
  }
  const sortedDeviations = [...deviations].sort();
  if (deviations.some((d, i) => d !== sortedDeviations[i])) {
    reasons.push("deviations_not_sorted: known_deviations must be sorted ascending");
  }

  if (bundle.source.commit_sha.length !== bundle.source.tree_digest.length) {
    reasons.push(
      "hash_width_mismatch: source.commit_sha and source.tree_digest have different widths -- one repository has one hash algorithm",
    );
  }

  if (bundle.rollback.previous_release_id === bundle.release_id) {
    reasons.push(
      "rollback_to_self: rollback.previous_release_id must differ from the bundle's own release_id",
    );
  }

  return reasons;
}

/** Validates `bundle` against release-evidence-bundle.schema.json, the personal-dimension
 * forbidden-key scan, and the bundle-level semantic checks above. Returns an empty array when
 * valid. Requires RELEASE_EVIDENCE_CONTRACTS_DIR (see env.ts). */
export function validateBundle(bundle: unknown): string[] {
  const { validate } = createValidator(getContractsDir());
  const reasons = validate(BUNDLE_SCHEMA_FILE, bundle);
  reasons.push(
    ...scanPersonalDimensions(bundle).map((v) => `personal_dimension_forbidden_key: ${v}`),
  );
  const deduped = dedupe(reasons);
  if (deduped.length > 0) return deduped;
  return dedupe(bundleSemanticChecks(bundle as Bundle));
}
