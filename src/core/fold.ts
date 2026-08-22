// The D5 transition graph, folded PER ATTEMPT (release_id, bundle_digest) -- never across
// attempts and never stored as computed state anywhere. This is a deliberate 1:1 port of
// GRAPH / EXPECTED_FAILURE_PHASE / foldAttempt / checkLedger in
// contracts/release-evidence/v0/verify-fixtures.mjs: the conformance test in
// test/conformance.test.ts pins this file's output against every event-collection and
// release-collection fixture in that repo, so GRAPH here must stay semantically identical to
// the reference graph, not just "similar enough".

import type { ReleaseEvent } from "./types.js";
import { dedupe } from "./util.js";

const GRAPH: Record<string, Record<string, string>> = {
  "(none)": { "prepared|null": "prepared" },
  prepared: { "deployed|preview": "preview_deployed", "failed|preview": "failed" },
  preview_deployed: { "verified|preview": "preview_verified", "failed|preview": "failed" },
  preview_verified: {
    "deployed|staging": "staging_deployed",
    "deployed|production": "production_deployed",
    "failed|staging": "failed",
    "failed|production": "failed",
  },
  staging_deployed: { "verified|staging": "staging_verified", "failed|staging": "failed" },
  staging_verified: { "deployed|production": "production_deployed", "failed|production": "failed" },
  production_deployed: {
    "verified|production": "production_verified",
    "failed|production": "failed",
    "rolled_back|production": "rolled_back",
  },
  production_verified: { "failed|production": "failed", "rolled_back|production": "rolled_back" },
  failed: {}, // rolled_back|production is allowed conditionally below (attempt must have reached production)
  rolled_back: {},
};

const EXPECTED_FAILURE_PHASE: Record<string, string> = {
  prepared: "deploy",
  preview_verified: "deploy",
  staging_verified: "deploy",
  preview_deployed: "verification",
  staging_deployed: "verification",
  production_deployed: "verification",
  production_verified: "post_verification",
};

export interface AttemptFoldResult {
  state: string;
  reachedProduction: boolean;
  problems: string[];
}

/** Folds one attempt's events (already filtered to a single (release_id, bundle_digest)) into
 * its derived state. Stops at the first illegal transition, same as the reference -- the
 * remainder of a broken attempt's events are not folded further. */
export function foldAttempt(
  releaseId: string,
  digest: string,
  events: ReleaseEvent[],
): AttemptFoldResult {
  let state = "(none)";
  let reachedProduction = false;
  const problems: string[] = [];

  for (const ev of events) {
    const key = `${ev.kind}|${ev.environment ?? "null"}`;

    if (ev.kind === "attested") {
      if (state === "(none)") {
        problems.push(
          `illegal_transition: attempt "${releaseId}"/${digest.slice(0, 14)} event "${ev.event_id}" -- attested before prepared`,
        );
        return { state, reachedProduction, problems };
      }
      continue; // attested leaves the derived state unchanged
    }

    let next = GRAPH[state]?.[key];
    if (!next && state === "failed" && key === "rolled_back|production" && reachedProduction) {
      // A failure record must not erase the rollback record: failed -> rolled_back is legal
      // only for an attempt that had actually reached production (sol must-7 in the protocol).
      next = "rolled_back";
    }
    if (!next) {
      problems.push(
        `illegal_transition: attempt "${releaseId}"/${digest.slice(0, 14)} event "${ev.event_id}" (${key}) is not legal from derived state "${state}"`,
      );
      return { state, reachedProduction, problems };
    }

    if (ev.kind === "failed") {
      const expected = EXPECTED_FAILURE_PHASE[state];
      if (ev.failure_phase !== expected) {
        problems.push(
          `failure_phase_mismatch: event "${ev.event_id}" declares failure_phase "${ev.failure_phase}" but the attempt was in state "${state}" (expected "${expected}")`,
        );
      }
    }

    if (key === "deployed|production") {
      const direct = state === "preview_verified";
      if (direct && ev.staging_skipped !== true) {
        problems.push(
          `staging_skip_unrecorded: event "${ev.event_id}" jumps preview_verified -> production without staging_skipped: true (D5: the skip FACT must be recorded on the event)`,
        );
      }
      if (!direct && ev.staging_skipped === true) {
        problems.push(
          `staging_skip_misrecorded: event "${ev.event_id}" declares staging_skipped after state "${state}" -- staging was not skipped`,
        );
      }
      reachedProduction = true;
    }

    state = next;
  }

  return { state, reachedProduction, problems };
}

export interface LedgerFoldResult {
  /** Keyed by `${release_id} ${bundle_digest}`, one entry per attempt found in the ledger. */
  attempts: Map<string, AttemptFoldResult>;
  /** Ledger-wide problems that are not any single attempt's fold: duplicate event_id and
   * dangling/self rollback references. */
  problems: string[];
}

/** Folds an entire ledger (or any slice of one) attempt-by-attempt, plus the ledger-wide
 * checks that need to see across attempts: duplicate event_id, and rollback target
 * resolution (a DIFFERENT release that reached production earlier in ledger order). */
export function foldLedger(events: ReleaseEvent[]): LedgerFoldResult {
  const problems: string[] = [];

  const ids = events.map((e) => e.event_id);
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    problems.push(`duplicate_event_id: "${dup}" appears more than once in the ledger`);
  }

  const grouped = new Map<string, ReleaseEvent[]>();
  for (const ev of events) {
    const key = `${ev.release_id} ${ev.bundle_digest}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(ev);
    else grouped.set(key, [ev]);
  }

  const attempts = new Map<string, AttemptFoldResult>();
  for (const [key, evs] of grouped) {
    const spaceIdx = key.indexOf(" ");
    const releaseId = key.slice(0, spaceIdx);
    const digest = key.slice(spaceIdx + 1);
    const result = foldAttempt(releaseId, digest, evs);
    attempts.set(key, result);
    problems.push(...result.problems);
  }

  events.forEach((ev, idx) => {
    if (ev.kind !== "rolled_back") return;
    if (ev.rollback_to_release_id === ev.release_id) {
      problems.push(`rollback_to_self: event "${ev.event_id}" rolls back to its own release_id`);
      return;
    }
    const targetReached = events.some(
      (e, i) =>
        i < idx &&
        e.release_id === ev.rollback_to_release_id &&
        e.kind === "deployed" &&
        e.environment === "production",
    );
    if (!targetReached) {
      problems.push(
        `dangling_rollback_reference: event "${ev.event_id}" rolls back to "${ev.rollback_to_release_id}", which never reached production earlier in this ledger`,
      );
    }
  });

  return { attempts, problems: dedupe(problems) };
}
