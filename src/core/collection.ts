// The `release-collection` fixture type's full cross-record check: every bundle individually
// valid, every event individually valid, every event's bundle_digest resolved against the
// REAL JCS sha256 of a bundle in the same collection (a repeated string proves nothing), the
// ledger fold, the two production gates, and bundle.rollback.previous_release_id resolution.
// A 1:1 port of checkReleaseCollection() in
// contracts/release-evidence/v0/verify-fixtures.mjs, including its two early-return points
// (schema validity, then digest/release_id cross-check) -- everything after those two points
// keeps accumulating into the same problems list even when later checks also fail.

import { bundleDigest, validateBundle } from "./bundle.js";
import { validateEvent } from "./event.js";
import { foldLedger } from "./fold.js";
import { checkProductionGate } from "./gates.js";
import type { Bundle, ReleaseEvent } from "./types.js";
import { dedupe } from "./util.js";

export interface ReleaseCollection {
  bundles: Bundle[];
  events: ReleaseEvent[];
}

export function checkReleaseCollection({ bundles, events }: ReleaseCollection): string[] {
  const problems: string[] = [];
  const digestToBundle = new Map<string, Bundle>();

  bundles.forEach((b, i) => {
    const reasons = validateBundle(b);
    if (reasons.length > 0) {
      problems.push(`bundle[${i}] not individually valid: ${reasons.join("; ")}`);
      return;
    }
    digestToBundle.set(bundleDigest(b), b);
  });

  events.forEach((ev, i) => {
    const reasons = validateEvent(ev);
    if (reasons.length > 0)
      problems.push(`event[${i}] not individually valid: ${reasons.join("; ")}`);
  });

  if (problems.length > 0) return dedupe(problems);

  for (const ev of events) {
    const bundle = digestToBundle.get(ev.bundle_digest);
    if (!bundle) {
      problems.push(
        `bundle_digest_unresolved: event "${ev.event_id}" carries bundle_digest ${ev.bundle_digest.slice(0, 18)}..., which is not the JCS sha256 of any bundle in this collection (a repeated string is not evidence)`,
      );
    } else if (bundle.release_id !== ev.release_id) {
      problems.push(
        `release_id_mismatch: event "${ev.event_id}" (release_id "${ev.release_id}") references the bundle of "${bundle.release_id}"`,
      );
    }
  }

  if (problems.length > 0) return dedupe(problems);

  const { problems: ledgerProblems } = foldLedger(events);
  problems.push(...ledgerProblems);

  // Production gates, checkable only with the real bundle at hand.
  events.forEach((ev, idx) => {
    if (!(ev.kind === "deployed" && ev.environment === "production")) return;
    const bundle = digestToBundle.get(ev.bundle_digest);
    if (!bundle) return; // already reported above; digestToBundle miss can't happen here
    const priorAttemptEvents = events
      .slice(0, idx)
      .filter((e) => e.bundle_digest === ev.bundle_digest);
    problems.push(...checkProductionGate(bundle, priorAttemptEvents));
  });

  // Bundle rollback pointer resolution (against the same collection).
  const knownReleases = new Set(bundles.map((b) => b.release_id));
  for (const b of bundles) {
    const prev = b.rollback.previous_release_id;
    if (prev !== null && !knownReleases.has(prev) && !events.some((e) => e.release_id === prev)) {
      problems.push(
        `previous_release_unresolved: bundle "${b.release_id}" names previous_release_id "${prev}", which appears nowhere in this collection`,
      );
    }
  }

  return dedupe(problems);
}
