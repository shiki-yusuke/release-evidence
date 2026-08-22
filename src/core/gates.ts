// Production gates: the two of v0's three gate checks that need the real bundle at hand, not
// just the ledger (the third -- the transition graph itself requiring preview_verified /
// staging_verified -- is enforced by fold.ts). Mirrors the production-gate loop inside
// checkReleaseCollection() in contracts/release-evidence/v0/verify-fixtures.mjs.

import type { Bundle, ReleaseEvent } from "./types.js";

/** Checks whether `bundle` is legally allowed to be deployed to production, given the events
 * of its OWN attempt (same bundle_digest) that occurred earlier in the ledger. Returns an
 * empty array when the gate passes.
 *
 * - lane-backed bundle (`lane_ref !== null`) ⇒ a prior `attested` event of kind
 *   `lane_done_overlay` must exist for this attempt (a lane's Phase-5 done overlay cannot
 *   exist at seal time, so it arrives as an attestation instead of a bundle edit).
 * - `review.decision === "commented"` is never a pass -- a comment is provenance, not
 *   release-safety evidence.
 *
 * Does NOT check the transition graph itself (whether jumping to production is legal from the
 * attempt's current state) -- that is fold.ts's job and must run first. */
export function checkProductionGate(bundle: Bundle, priorAttemptEvents: ReleaseEvent[]): string[] {
  const problems: string[] = [];

  if (bundle.lane_ref !== null) {
    const attested = priorAttemptEvents.some(
      (e) => e.kind === "attested" && e.attestation?.kind === "lane_done_overlay",
    );
    if (!attested) {
      problems.push(
        `production_gate_missing_done_attestation: bundle "${bundle.release_id}" is lane-backed but no prior lane_done_overlay attestation was found for this attempt`,
      );
    }
  }

  if (bundle.review !== null && bundle.review.decision === "commented") {
    problems.push(
      `production_gate_review_not_passed: bundle "${bundle.release_id}" has review.decision "commented" -- a comment is not a pass`,
    );
  }

  return problems;
}
