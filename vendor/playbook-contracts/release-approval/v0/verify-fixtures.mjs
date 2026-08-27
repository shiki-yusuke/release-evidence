#!/usr/bin/env node
// Verifies contracts/release-approval/v0/fixtures/* against release-approval-event.schema.json
// plus the semantic MUSTs the schema alone cannot express (docs/protocols/release-approval-v0.md):
//
//   event-level:   event_id recomputed as sha256(JCS(event without event_id)) (R18); a
//                  declared value that does not match is rejected. occurred_at/expires_at must
//                  parse to real calendar dates (a syntactically well-formed but nonsensical
//                  string like "2026-99-99T00:00:00Z" passes the schema's regex and is caught
//                  only here), and expires_at must be strictly after occurred_at.
//
//   composite:     the ONLY fixture type in this contract (must-3, sol architect review: the
//                  standalone "ledger" type is retired -- every R19-scoped conformance ledger is
//                  a composite bundling review-findings records, an optional array of embedded
//                  release-evidence/v0 bundles, one promotion-receipt, and a release-approval
//                  ledger). This is the only place the cross-contract truths TEST-05/06/09/11/12/13
//                  actually require can be checked:
//                    - re-validates each embedded record/receipt against ITS OWN contract's
//                      checker (imported, not reimplemented -- checkRecord from review-findings,
//                      checkReceipt from promotion-receipt);
//                    - duplicate event_id across the ledger (R18/R24);
//                    - recomputes the REAL JCS sha256 of the embedded receipt and requires every
//                      approval event's subject.receipt_digest to resolve to it (TEST-06);
//                    - requires subject.receipt_semantic_digest / bundle_digest /
//                      selection_manifest_digest / target to match the embedded receipt's OWN
//                      current values -- any drift is a stale approval binding (TEST-05);
//                    - approval_granted is valid ONLY against a receipt whose verdict is
//                      ready_for_approval; only break_glass_approve may bind to a non-ready
//                      receipt (R22/TEST-11);
//                    - approval_revoked's revoked_approval_event_id must resolve, within the
//                      SAME ledger, to an approval_granted or break_glass_approve event, with a
//                      matching subject and an occurred_at strictly after the target's (R19
//                      extension/TEST-13);
//                    - break_glass_approve's bypassed_predicate_ids must all actually appear
//                      among the referenced receipt's own predicates[] (bypassing a predicate
//                      the receipt never evaluated, e.g. a post_deploy-only predicate_id cited
//                      against a pre_promotion receipt, is meaningless);
//                    - resolves each satisfied/contradicted predicate's evidence_refs: a
//                      review_finding ref's anchor is `<record_id>#<finding_id>` (must resolve to
//                      a real finding in that record) or `<record_id>#scope` (valid only when
//                      that record's outcome is none_observed_in_recorded_scope), and its digest
//                      must equal the referenced record's ACTUAL, WHOLE-RECORD JCS sha256 (R23 --
//                      not the record's subject.digest; editing claim/severity/outcome changes
//                      this digest, TEST-12); a release_evidence ref resolves against an embedded
//                      bundle by BUNDLE DIGEST, with the same real-JCS-digest discipline, and is
//                      simply uncounted (not itself an error) when no matching bundle is embedded
//                      -- a predicate backed ONLY by such a ref is unresolved, not silently passed
//                      (must-2c). Every satisfied/contradicted predicate needs at least one
//                      evidence_ref that ACTUALLY resolves this way, or it is rejected.
//
//   round-2 fixes (sol architect review, blockers + a regression):
//     - each embedded `bundles[]` entry is validated against release-evidence/v0's OWN schema
//       (read-only reference; that contract is never modified here) plus the personal-dimension
//       scan -- an arbitrary object can no longer be embedded and treated as real evidence merely
//       because SOME digest can be computed from it. Bundles are indexed by their OWN JCS digest
//       (not release_id), since one release_id can legitimately have multiple attempts at
//       different digests (release-evidence/v0's own fold unit); two bundles sharing the same
//       digest are a duplicate embed and rejected.
//     - the receipt's OWN `subject.bundle_digest` must resolve to a REAL embedded bundle --
//       mutual agreement between receipt.subject and approval.subject alone is not evidence
//       resolution, only internal consistency.
//     - revocation's subject-equality check compares `canonicalize()` output, not
//       `JSON.stringify()`, so two subjects that agree on every field but differ only in key
//       order compare equal (a real regression the JSON.stringify version had).
//
//   round-3/4 fix (sol architect review, blockers): at the time this was written,
//     contracts/shared/schema-validator.mjs did not evaluate `oneOf` at all, so an embedded
//     bundle's `lane_ref`/`review` (the only two places release-evidence-bundle.schema.json
//     relies on `oneOf` alone, with no sibling allOf/if-then enforcement) could be any value --
//     e.g. `lane_ref: 42`, or a single-element array coerced through a bare regex `.test()` --
//     and pass `checkEmbeddedBundle` undetected. `laneRefMatchesUnion`/`reviewMatchesUnion`
//     reproduce each oneOf branch by hand, with explicit `typeof === "string"` guards before
//     every pattern test.
//
//   UPDATE (I-2026-08-23-shared-validator-oneof): contracts/shared/schema-validator.mjs now
//     evaluates `oneOf` itself (same repo, separate lane) -- `validateReleaseEvidence()` above
//     therefore already catches `lane_ref: 42` / `review: 42` on its own. The two functions
//     below are kept anyway as **defense-in-depth**: they were true independent verification
//     before that fix existed, this file's own logic did not change, and removing them would
//     make this contract's own correctness depend entirely on the shared validator never
//     regressing. Vendored/pinned copies of schema-validator.mjs elsewhere (commit-pinned
//     UPSTREAM markers) also do not get this fix until they are re-vendored, which this
//     supplement is unaffected by either way.
//
// Zero npm dependencies by design. Usage: node verify-fixtures.mjs (no args, no network).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";
import { checkRecord } from "../../review-findings/v1/verify-fixtures.mjs";
import { checkReceipt } from "../../promotion-receipt/v0/verify-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);
// sol architect review round 2, blocker-1: embedded bundles[] are release-evidence/v0's own
// artifact type -- validated against ITS schema (read-only reference; contracts/release-evidence
// is never modified). Bundle-level SEMANTIC MUSTs (artifacts sorted+unique, hash-width match,
// etc.) remain that contract's verifier's own responsibility -- see docs/protocols/
// release-approval-v0.md's "What v0 deliberately leaves out".
const { validate: validateReleaseEvidence } = createValidator(path.join(HERE, "../../release-evidence/v0"));

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];

// Broadened (sol architect should-4): matches any key whose lowercased name CONTAINS
// "confidence", not only an exact "confidence" key -- copied identically into review-findings/v1's
// and promotion-receipt/v0's own verify-fixtures.mjs (contracts/shared cannot be touched).
function scanNumericConfidence(value, pathStr = "") {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...scanNumericConfidence(item, `${pathStr}[${i}]`)));
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (key.toLowerCase().includes("confidence") && typeof val === "number") violations.push(here);
      violations.push(...scanNumericConfidence(val, here));
    }
  }
  return violations;
}

function isRealTimestamp(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

// R18: event_id = sha256(JCS(event without event_id)).
function computeEventId(event) {
  const { event_id, ...rest } = event;
  return `sha256:${sha256hex(canonicalize(rest))}`;
}

function jcsDigestOf(obj) {
  return `sha256:${sha256hex(canonicalize(obj))}`;
}

function checkEventSchemaAndId(event) {
  const reasons = [];
  reasons.push(...validate("release-approval-event.schema.json", event));
  reasons.push(...scanPersonalDimensions(event).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...scanNumericConfidence(event).map((v) => `numeric_confidence_forbidden_field: ${v}`));
  if (reasons.length > 0) return dedupe(reasons);

  if (!isRealTimestamp(event.occurred_at)) {
    reasons.push(`invalid_calendar_timestamp: event "${event.event_id}" occurred_at "${event.occurred_at}" does not parse to a real date/time`);
  }
  if (event.expires_at !== undefined) {
    if (!isRealTimestamp(event.expires_at)) {
      reasons.push(`invalid_calendar_timestamp: event "${event.event_id}" expires_at "${event.expires_at}" does not parse to a real date/time`);
    } else if (isRealTimestamp(event.occurred_at) && Date.parse(event.expires_at) <= Date.parse(event.occurred_at)) {
      reasons.push(`expiry_not_after_occurrence: event "${event.event_id}" expires_at (${event.expires_at}) is not strictly after occurred_at (${event.occurred_at})`);
    }
  }

  const expectedId = computeEventId(event);
  if (event.event_id !== expectedId) {
    reasons.push(`event_id_mismatch: event declares "${event.event_id}", recomputed "${expectedId}"`);
  }
  return dedupe(reasons);
}

function checkLedger(events, problems) {
  const ids = events.map((e) => e.event_id);
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    problems.push(`duplicate_event_id: "${dup}" appears more than once in the ledger`);
  }
}

// R23/ask-3: resolves one review_finding evidence_ref against the composite's findings records.
function resolveReviewFindingRef(ref, findingsById) {
  const reasons = [];
  const parts = ref.ref.split("#");
  if (parts.length !== 2) {
    reasons.push(`evidence_ref_invalid_anchor: review_finding ref "${ref.ref}" must be "<record_id>#<finding_id>" or "<record_id>#scope"`);
    return { resolved: false, reasons };
  }
  const [recordId, anchor] = parts;
  const record = findingsById.get(recordId);
  if (!record) {
    reasons.push(`evidence_ref_unresolved: review_finding "${ref.ref}" does not resolve to any findings record in this ledger`);
    return { resolved: false, reasons };
  }
  if (anchor === "scope") {
    if (record.outcome !== "none_observed_in_recorded_scope") {
      reasons.push(`evidence_ref_invalid_anchor: "${ref.ref}" uses the #scope anchor, but record "${recordId}" outcome is "${record.outcome}" (must be none_observed_in_recorded_scope)`);
      return { resolved: false, reasons };
    }
  } else {
    const found = (record.findings ?? []).some((f) => f.finding_id === anchor);
    if (!found) {
      reasons.push(`evidence_ref_invalid_anchor: "${ref.ref}" names finding_id "${anchor}", which does not exist in record "${recordId}"`);
      return { resolved: false, reasons };
    }
  }
  const recordDigest = jcsDigestOf(record);
  if (recordDigest !== ref.digest) {
    reasons.push(
      `evidence_ref_digest_mismatch: review_finding "${ref.ref}" digest ${ref.digest.slice(0, 18)}... does not match record "${recordId}"'s actual JCS sha256 ${recordDigest.slice(0, 18)}... (R23: bound to the WHOLE record, not subject.digest -- a content edit changes this)`,
    );
    return { resolved: false, reasons };
  }
  return { resolved: true, reasons };
}

// Originally written (sol architect review round 3, blocker) because
// contracts/shared/schema-validator.mjs did not evaluate `oneOf` at all -- it was used only as
// prose-adjacent documentation elsewhere in this repo's schemas, with the real enforcement always
// carried by a sibling allOf/if-then (see e.g. release-evidence/v0's own release-event schema for
// `environment`). release-evidence-bundle.schema.json's `lane_ref` and `review` properties were
// the ONLY two places in that schema that relied on `oneOf` ALONE with no such sibling
// enforcement -- so `validateReleaseEvidence()` above let a value like `lane_ref: 42` or
// `review: 42` straight through.
//
// UPDATE (I-2026-08-23-shared-validator-oneof): contracts/shared/schema-validator.mjs now
// evaluates `oneOf` itself (same repo, separate lane), so `validateReleaseEvidence()` above
// already catches this on its own. These two functions are kept as **defense-in-depth** --
// removing them would make this contract's correctness depend entirely on the shared validator
// never regressing, and a commit-pinned vendored copy elsewhere would not get that fix until
// re-vendored anyway. They reproduce each `oneOf` branch's required/type rules by hand, read
// directly off release-evidence-bundle.schema.json's current text (its `lane_ref` oneOf is around
// line 66; `review`'s is around line 139). If that schema's oneOf shapes ever change, these must
// be updated to match -- they are NOT re-derived automatically from the schema file.
//
// round-4 fix (sol architect review, blocker): every string-typed field below is checked with an
// explicit `typeof v === "string"` BEFORE the regex test, never `pattern.test(v)` alone --
// RegExp.prototype.test coerces its argument via ToString, so a single-element array like
// `["sha256:aa...aa"]` stringifies to exactly that inner string (Array.prototype.toString joins
// with "," and a lone element has no comma to show) and would otherwise pass a digest/head_sha
// pattern check despite not actually being a string in the JSON.
const LANE_REF_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LANE_REF_REQUIRED = ["lane_id", "intent_digest", "spec_digest", "consensus_ack_digest", "verification_digest"];
const LANE_REF_OPTIONAL = ["premise_evidence_digest", "matrix_digest"];

function laneRefMatchesUnion(value) {
  if (value === null) return true; // oneOf branch 2: null
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...LANE_REF_REQUIRED, ...LANE_REF_OPTIONAL]);
  if (!Object.keys(value).every((k) => allowed.has(k))) return false;
  if (!LANE_REF_REQUIRED.every((k) => k in value)) return false;
  if (typeof value.lane_id !== "string" || value.lane_id.length < 1) return false;
  for (const k of [...LANE_REF_REQUIRED.slice(1), ...LANE_REF_OPTIONAL]) {
    if (k in value && (typeof value[k] !== "string" || !LANE_REF_DIGEST_PATTERN.test(value[k]))) return false;
  }
  return true; // oneOf branch 1: the lane_ref object shape
}

const REVIEW_HEAD_SHA_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const REVIEW_REQUIRED = ["pr", "head_sha", "decision"];
const REVIEW_DECISION_ENUM = ["approved", "commented", "self_merged"];

function reviewMatchesUnion(value) {
  if (value === null) return true; // oneOf branch 2: null
  if (typeof value !== "object" || Array.isArray(value)) return false;
  if (!Object.keys(value).every((k) => REVIEW_REQUIRED.includes(k))) return false;
  if (!REVIEW_REQUIRED.every((k) => k in value)) return false;
  if (!(Number.isInteger(value.pr) && value.pr >= 1)) return false;
  if (typeof value.head_sha !== "string" || !REVIEW_HEAD_SHA_PATTERN.test(value.head_sha)) return false;
  if (typeof value.decision !== "string" || !REVIEW_DECISION_ENUM.includes(value.decision)) return false;
  return true; // oneOf branch 1: the review object shape
}

// sol architect review round 2, blocker-1: an embedded release-evidence/v0 bundle is validated
// against ITS OWN schema + the oneOf-shape supplement above + the personal-dimension scan -- a
// composite can no longer embed an arbitrary object and have its JCS digest treated as evidence.
function checkEmbeddedBundle(bundle) {
  const reasons = [];
  reasons.push(...validateReleaseEvidence("release-evidence-bundle.schema.json", bundle));
  if (bundle !== null && typeof bundle === "object" && !Array.isArray(bundle)) {
    if (!laneRefMatchesUnion(bundle.lane_ref)) reasons.push("embedded_bundle_union_shape: lane_ref");
    if (!reviewMatchesUnion(bundle.review)) reasons.push("embedded_bundle_union_shape: review");
  }
  reasons.push(...scanPersonalDimensions(bundle).map((v) => `personal_dimension_forbidden_key: ${v}`));
  return dedupe(reasons);
}

// must-2c: resolves one release_evidence evidence_ref against embedded bundles, if any. Indexed
// by BUNDLE DIGEST (sol architect review round 2, blocker-1), not release_id: a release can
// legitimately have multiple attempts (release-evidence/v0's own unit is (release_id,
// bundle_digest)), so several bundles sharing one release_id but carrying different digests are
// all valid to embed side by side; two embedded bundles sharing the SAME digest are a duplicate
// (checked where bundlesByDigest is built). Absence of any embedded bundle matching a ref's
// digest is NOT itself an error -- the ref is simply uncounted -- but a release_id match at a
// DIFFERENT digest is a concrete mismatch, surfaced as such for a clearer diagnostic.
function resolveReleaseEvidenceRef(ref, bundlesByDigest, validBundles) {
  const reasons = [];
  const bundle = bundlesByDigest.get(ref.digest);
  if (bundle) {
    if (bundle.release_id !== ref.ref) {
      reasons.push(`release_evidence_ref_release_id_mismatch: ref names release_id "${ref.ref}" but the embedded bundle at digest ${ref.digest.slice(0, 18)}... has release_id "${bundle.release_id}"`);
      return { resolved: false, reasons };
    }
    return { resolved: true, reasons };
  }
  const candidate = validBundles.find((b) => b.release_id === ref.ref);
  if (candidate) {
    reasons.push(
      `release_evidence_digest_mismatch: release_evidence "${ref.ref}" digest ${ref.digest.slice(0, 18)}... does not match any embedded bundle's actual JCS sha256 for this release_id (e.g. ${jcsDigestOf(candidate).slice(0, 18)}...)`,
    );
  }
  return { resolved: false, reasons };
}

function checkComposite({ findings, bundles, receipt, approval_events }, problems) {
  const findingsById = new Map();
  for (const [i, record] of (findings ?? []).entries()) {
    const reasons = checkRecord(record);
    if (reasons.length > 0) {
      problems.push(`findings[${i}] not individually valid: ${reasons.join("; ")}`);
    } else {
      findingsById.set(record.record_id, record);
    }
  }

  const bundlesByDigest = new Map();
  const validBundles = [];
  for (const [i, b] of (bundles ?? []).entries()) {
    const reasons = checkEmbeddedBundle(b);
    if (reasons.length > 0) {
      problems.push(`bundles[${i}] not individually valid: ${reasons.join("; ")}`);
      continue;
    }
    const digest = jcsDigestOf(b);
    if (bundlesByDigest.has(digest)) {
      problems.push(`duplicate_embedded_bundle: bundles[${i}] (release_id "${b.release_id}") has the same JCS digest as an earlier embedded bundle -- embed each attempt once`);
      continue;
    }
    bundlesByDigest.set(digest, b);
    validBundles.push(b);
  }

  const receiptReasons = checkReceipt(receipt);
  if (receiptReasons.length > 0) {
    problems.push(`receipt not individually valid: ${receiptReasons.join("; ")}`);
  }

  const eventProblems = [];
  for (const [i, ev] of (approval_events ?? []).entries()) {
    const reasons = checkEventSchemaAndId(ev);
    if (reasons.length > 0) eventProblems.push(`approval_events[${i}] not individually valid: ${reasons.join("; ")}`);
  }
  problems.push(...eventProblems);
  if (problems.length > 0) return;

  // sol architect review round 2, blocker-2: mutual consistency between receipt.subject and
  // approval.subject (checked below) is not, by itself, evidence resolution -- the receipt's own
  // bundle_digest must resolve to a REAL embedded bundle, or the whole chain is unanchored.
  if (!bundlesByDigest.has(receipt.subject.bundle_digest)) {
    problems.push(`bundle_digest_unresolved: receipt's subject.bundle_digest ${receipt.subject.bundle_digest.slice(0, 18)}... does not resolve to any embedded bundle in this composite`);
  }
  if (problems.length > 0) return;

  checkLedger(approval_events, problems);
  if (problems.length > 0) return;

  const eventsById = new Map(approval_events.map((e) => [e.event_id, e]));
  const realReceiptDigest = jcsDigestOf(receipt);

  for (const ev of approval_events) {
    if (ev.subject.receipt_digest !== realReceiptDigest) {
      problems.push(
        `receipt_digest_unresolved: event "${ev.event_id}" carries receipt_digest ${ev.subject.receipt_digest.slice(0, 18)}..., which is not the JCS sha256 of the receipt in this ledger`,
      );
      continue;
    }
    // R19 exact-binding: every subject field must match the embedded receipt's OWN current
    // values. Any drift is a stale approval, regardless of which field drifted.
    if (ev.subject.receipt_semantic_digest !== receipt.semantic_digest) {
      problems.push(`stale_approval_binding: event "${ev.event_id}" receipt_semantic_digest does not match the receipt's current semantic_digest`);
    }
    if (ev.subject.bundle_digest !== receipt.subject.bundle_digest) {
      problems.push(`stale_approval_binding: event "${ev.event_id}" bundle_digest ${ev.subject.bundle_digest.slice(0, 18)}... does not match the receipt's subject.bundle_digest`);
    }
    if (ev.subject.selection_manifest_digest !== receipt.subject.selection_manifest_digest) {
      problems.push(`stale_approval_binding: event "${ev.event_id}" selection_manifest_digest does not match the receipt's`);
    }
    if (ev.subject.target !== receipt.subject.target) {
      problems.push(`stale_approval_binding: event "${ev.event_id}" target "${ev.subject.target}" does not match the receipt's target "${receipt.subject.target}"`);
    }

    // should-1: the approval cannot predate the evaluation it approves.
    if (isRealTimestamp(ev.occurred_at) && isRealTimestamp(receipt.evaluated_at) && Date.parse(ev.occurred_at) <= Date.parse(receipt.evaluated_at)) {
      problems.push(`approval_before_evaluation: event "${ev.event_id}" occurred_at (${ev.occurred_at}) is not after the receipt's evaluated_at (${receipt.evaluated_at})`);
    }

    // R22/TEST-11: approval_granted is valid only against a ready_for_approval receipt.
    if (ev.kind === "approval_granted" && receipt.verdict !== "ready_for_approval") {
      problems.push(`approval_granted_requires_ready_receipt: event "${ev.event_id}" is approval_granted but the receipt's verdict is "${receipt.verdict}" (only break_glass_approve may bind to a non-ready receipt)`);
    }

    // should-3: a break-glass bypass must name predicates the receipt actually evaluated.
    if (ev.kind === "break_glass_approve") {
      const receiptPredicateIds = new Set(receipt.predicates.map((p) => p.predicate_id));
      for (const id of ev.bypassed_predicate_ids) {
        if (!receiptPredicateIds.has(id)) {
          problems.push(`bypassed_predicate_not_in_receipt: event "${ev.event_id}" bypasses predicate_id "${id}", which does not appear in the referenced receipt's predicates (phase mismatch or typo)`);
        }
      }
    }

    // R19 extension/TEST-13: revocation must resolve to a real grant/break-glass event, with a
    // matching subject, strictly after that event's own occurred_at.
    if (ev.kind === "approval_revoked") {
      const target = eventsById.get(ev.revoked_approval_event_id);
      if (!target) {
        problems.push(`revoke_target_unresolved: event "${ev.event_id}" revokes "${ev.revoked_approval_event_id}", which does not exist in this ledger`);
      } else if (target.kind !== "approval_granted" && target.kind !== "break_glass_approve") {
        problems.push(`revoke_target_wrong_kind: event "${ev.event_id}" revokes "${target.event_id}", whose kind is "${target.kind}" (must be approval_granted or break_glass_approve)`);
      } else {
        // canonicalize (not JSON.stringify) -- two subjects that agree on every field but were
        // serialized with keys in a different order must compare EQUAL (sol architect review
        // round 2, regression fix): JSON.stringify is order-sensitive and would wrongly reject a
        // legitimate revoke over nothing but key ordering.
        if (canonicalize(ev.subject) !== canonicalize(target.subject)) {
          problems.push(`revoke_subject_mismatch: event "${ev.event_id}" subject does not match the subject of the event it revokes ("${target.event_id}")`);
        }
        if (!(isRealTimestamp(ev.occurred_at) && isRealTimestamp(target.occurred_at) && Date.parse(ev.occurred_at) > Date.parse(target.occurred_at))) {
          problems.push(`revoke_before_grant: event "${ev.event_id}" occurred_at (${ev.occurred_at}) is not strictly after the revoked event's occurred_at (${target.occurred_at})`);
        }
      }
    }
  }
  if (problems.length > 0) return;

  // must-2b/c, R23: every satisfied/contradicted predicate needs at least one evidence_ref that
  // ACTUALLY resolves -- not merely one of a resolvable KIND (promotion-receipt's own verifier
  // already checked that structural half).
  for (const p of receipt.predicates) {
    if (p.status !== "satisfied" && p.status !== "contradicted") continue;
    let resolvedAny = false;
    for (const ref of p.evidence_refs) {
      if (ref.kind === "review_finding") {
        const { resolved, reasons } = resolveReviewFindingRef(ref, findingsById);
        problems.push(...reasons);
        if (resolved) resolvedAny = true;
      } else if (ref.kind === "release_evidence") {
        const { resolved, reasons } = resolveReleaseEvidenceRef(ref, bundlesByDigest, validBundles);
        problems.push(...reasons);
        if (resolved) resolvedAny = true;
      }
      // kind === "other" never counts and is never itself flagged here.
    }
    if (!resolvedAny) {
      problems.push(`predicate_evidence_unresolved: predicate "${p.predicate_id}" (status=${p.status}) has no evidence_ref that actually resolves to real content in this ledger`);
    }
  }
}

function runFixture(entry) {
  const problems = [];
  const data = read(entry.files);
  if (entry.type === "event") {
    problems.push(...checkEventSchemaAndId(data));
  } else if (entry.type === "composite") {
    checkComposite(data, problems);
  } else {
    problems.push(`unknown fixture type "${entry.type}"`);
  }
  return { category: problems.length ? "reject" : "accept", reasons: problems };
}

function main() {
  const manifest = read("expected-results.json");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
    process.exit(1);
  }
  const declared = new Set(manifest.fixtures.map((e) => e.files));
  if (declared.size !== manifest.fixtures.length) {
    console.error("expected-results.json lists the same fixture twice -- refusing.");
    process.exit(1);
  }
  const onDisk = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json") && f !== "expected-results.json");
  const undeclared = onDisk.filter((f) => !declared.has(f));
  const missing = [...declared].filter((f) => !onDisk.includes(f));
  if (undeclared.length > 0 || missing.length > 0) {
    console.error(`fixture/manifest drift -- undeclared on disk: [${undeclared}] / declared but absent: [${missing}]`);
    process.exit(1);
  }

  let failures = 0;
  console.log(`release-approval:v0 fixture verification (${manifest.fixtures.length} fixtures)\n`);
  for (const entry of manifest.fixtures) {
    const result = runFixture(entry);
    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      ok = result.reasons.some((r) => r.includes(entry.reason_code));
    }
    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.files}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok) for (const r of result.reasons) console.log(`        ${r}`);
  }
  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures behave as declared.`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
