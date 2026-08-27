// evaluate(input): ShadowEvaluation -- the pure-function evaluation core (spec.md "決定論").
//
// The vendored promotion-receipt/v0 contract (vendor/playbook-contracts/promotion-receipt/v0/)
// fixes the pre_promotion predicate_id closed set, the evidence_refs shape, and the verdict
// derivation rule -- but it does NOT define what release-evidence/v0 fact each predicate checks
// (there is no reference evaluator yet; see docs/protocols/promotion-receipt-v0.md's own
// "no reference implementer exists yet"). Mapping each predicate onto this repo's own Bundle /
// ReleaseEvent domain is this file's job, and the mapping decisions are recorded in
// docs/spec/I-2026-08-27-f-shadow-evaluator/implement-notes.md ("chunk 2 の非自明な判断").
//
// Two wrapper-level gates run BEFORE any predicate is evaluated, because candidate_receipt.subject
// only ever echoes input.subject verbatim (it never reads bundle/manifest CONTENT), so the one
// thing that must be true before a receipt is worth generating at all is that both digests
// actually resolve to *some* record in the given exact-record pool (existence, not correctness --
// correctness of the resolved content, e.g. wrong `kind`, is each predicate's own concern, most
// visibly artifact_identity's):
//
//   - selection_manifest_digest unresolved -> evaluation_status="unknown", reason=unknown_structural
//     (spec.md: "selection_manifest 不在 -- ゼロ digest・逆算禁止")
//   - bundle_digest unresolved -> evaluation_status="unknown", reason=referent_unresolved
//
// A THIRD gate (terra review round C, must-2 residual) applies the same discipline to a non-null
// `policy.digest`: it must resolve to a `policy_snapshot`-kind record, or evaluation_status
// becomes "unknown"/referent_unresolved too -- "「未解決でも黙って receipt 生成」経路を削除".
// `policy.digest === null` (the schema-required, honest "no policy snapshot" declaration --
// input.ts's `absent_reason`) is NOT gated: no predicate reads policy_snapshot content today, so
// its absence must never block or change an otherwise-decidable evaluation (spec.md "捏造せず
// 正直に" cuts both ways -- fabricating a fake resolution is as wrong as fabricating a fake
// blocker). `buildCandidateReceipt` fills the receipt's own mandatory `policy_digest` field with a
// fixed, documented sentinel in that case (see `POLICY_DIGEST_ABSENT_SENTINEL`).
//
// None of the three gates is reachable once `pool.errors` is non-empty (tampered input) -- that
// short-circuits to evaluation_status="invalid_input" first, before any gate even runs.
//
// No Date.now() / argument-less new Date() / Math.random() / crypto.randomUUID() / process.env /
// fs / network in this file -- see spec.md "決定論". `evaluation_cut` is the only clock this file
// ever reads, and only because the caller supplied it.

import { foldAttempt } from "../core/fold.js";
import type { LaneRefOmittedCode, ReleaseEvent } from "../core/types.js";
import type {
  CandidateReceipt,
  EvidenceRef,
  ExactRecord,
  PrePromotionPredicateId,
  PredicateObservation,
  ReceiptPredicate,
  ShadowEvaluation,
  ShadowEvaluationInput,
} from "./input.js";
import { PRE_PROMOTION_PREDICATE_IDS } from "./input.js";
import { type InputError, inputError, laneRefOmittedReason, unknownReason } from "./reasons.js";
import { type ResolvedRecordPool, resolveByDigest, resolveRecordPool } from "./resolver.js";
import {
  computeInputManifestDigest,
  computeRecordDigest,
  computeSemanticDigest,
  deriveReceiptId,
  recordContentDigest,
  sortInputErrors,
  sortInputManifestRefs,
} from "./serialize.js";

/** This evaluator's own version tag (spec.md: `evaluator.version`). A constant, not
 * package.json's version read at runtime -- reading a file is fs, banned in shadow core. Bump by
 * hand alongside a deliberate change to this file's evaluation behavior. */
export const SHADOW_EVALUATOR_VERSION = "0.1.0";

/** Vendored promotion-receipt/v0's `policy_digest` is a REQUIRED, always-a-string field (never
 * nullable -- this evaluator does not own that contract and does not change it), but
 * `input.policy.digest === null` is now a legitimate, schema-required declaration that no policy
 * snapshot was captured for this evaluation (terra review round C, input.ts's `absent_reason`).
 * `policy_digest` has never been evidence any predicate resolves against or any contract checker
 * verifies resolvability of (`grep policy_digest vendor/playbook-contracts/promotion-receipt/v0/
 * verify-fixtures.mjs` -- no hits; implement-notes.md already recorded that the pre-round-C
 * fixtures used non-resolving placeholder digests here and the contract accepted them) -- it is
 * frozen administrative metadata (R8), not a satisfied/contradicted claim. This fixed, documented
 * sentinel (never a per-evaluation-varying value, so it is trivially recognizable as "absent" and
 * never coincides with a real content digest by construction -- `recordContentDigest` of a string
 * literal, not of any real record shape) fills that mandatory field honestly when there is
 * genuinely nothing to echo, the same "never a zero/synthesized digest standing in for a resolved
 * referent" discipline spec.md already applies to selection_manifest. */
export const POLICY_DIGEST_ABSENT_SENTINEL = recordContentDigest("policy_snapshot_absent/v0");

// ---------------------------------------------------------------------------
// Loose, non-schema-validating shape guards for record CONTENT.
//
// Shadow core cannot call src/core/bundle.ts's validateBundle or src/core/event.ts's
// validateEvent -- both read RELEASE_EVIDENCE_CONTRACTS_DIR (process.env) and a schema file off
// disk (fs), both banned here (spec.md "決定論"). These guards are deliberately shallow: they
// check just enough shape to read the specific fields each predicate below needs, and return
// `null` (never throw) when content doesn't match -- callers treat `null` as "cannot decide",
// never as "decide against". Deep bundle-schema conformance (array sort/uniqueness, personal-
// dimension scan, ...) stays a CLI/test-layer concern (fs is fine there), not evaluate.ts's.
// ---------------------------------------------------------------------------

interface BundleLike {
  release_id: string;
  lane_ref: { verification_digest: string } | null;
  lane_ref_omitted_code: string | null;
  review: { decision: string } | null;
  review_omitted_code: string | null;
  rollback_previous_release_id: string | null;
}

function parseBundleLike(content: unknown): BundleLike | null {
  if (typeof content !== "object" || content === null) return null;
  const c = content as Record<string, unknown>;
  if (typeof c.release_id !== "string" || c.release_id.length === 0) return null;

  const rollback = c.rollback;
  if (typeof rollback !== "object" || rollback === null) return null;
  const previousReleaseId = (rollback as Record<string, unknown>).previous_release_id;
  if (previousReleaseId !== null && typeof previousReleaseId !== "string") return null;

  const laneRef = c.lane_ref;
  let parsedLaneRef: BundleLike["lane_ref"] = null;
  if (laneRef !== null) {
    if (typeof laneRef !== "object") return null;
    const verificationDigest = (laneRef as Record<string, unknown>).verification_digest;
    if (typeof verificationDigest !== "string") return null;
    parsedLaneRef = { verification_digest: verificationDigest };
  }
  const laneRefOmitted = c.lane_ref_omitted;
  const laneRefOmittedCode =
    typeof laneRefOmitted === "object" && laneRefOmitted !== null
      ? (((laneRefOmitted as Record<string, unknown>).code as string | undefined) ?? null)
      : null;

  const review = c.review;
  let parsedReview: BundleLike["review"] = null;
  if (review !== null) {
    if (typeof review !== "object") return null;
    const decision = (review as Record<string, unknown>).decision;
    if (typeof decision !== "string") return null;
    parsedReview = { decision };
  }
  const reviewOmitted = c.review_omitted;
  const reviewOmittedCode =
    typeof reviewOmitted === "object" && reviewOmitted !== null
      ? (((reviewOmitted as Record<string, unknown>).code as string | undefined) ?? null)
      : null;

  return {
    release_id: c.release_id,
    lane_ref: parsedLaneRef,
    lane_ref_omitted_code: laneRefOmittedCode,
    review: parsedReview,
    review_omitted_code: reviewOmittedCode,
    rollback_previous_release_id: previousReleaseId,
  };
}

interface ReleaseEventLike {
  release_id: string;
  kind: string;
  environment: string | null;
  bundle_digest: string;
  preview_skipped: boolean;
}

function parseReleaseEventLike(content: unknown): ReleaseEventLike | null {
  if (typeof content !== "object" || content === null) return null;
  const c = content as Record<string, unknown>;
  if (
    typeof c.release_id !== "string" ||
    typeof c.kind !== "string" ||
    typeof c.bundle_digest !== "string"
  ) {
    return null;
  }
  if (c.environment !== null && typeof c.environment !== "string") return null;
  return {
    release_id: c.release_id,
    kind: c.kind,
    environment: (c.environment as string | null | undefined) ?? null,
    bundle_digest: c.bundle_digest,
    preview_skipped: c.preview_skipped === true,
  };
}

function scanReleaseEvents(pool: ResolvedRecordPool): ReleaseEventLike[] {
  const out: ReleaseEventLike[] = [];
  for (const record of pool.byDigest.values()) {
    if (record.kind !== "release_event") continue;
    const ev = parseReleaseEventLike(record.content);
    if (ev) out.push(ev);
  }
  return out;
}

/** Chronological order by the event's own `occurred_at` (numeric epoch millis, never a naive
 * string compare -- same reasoning as `resolver.ts`'s `isAfterCut`), tie-broken by `event_id` for
 * a total, deterministic order. Deliberately NOT array-arrival order: spec.md "決定論" requires
 * `input.records` array order to never change the result, but the D5 transition graph (fold.ts)
 * IS order-sensitive by nature (a real lifecycle has a time axis) -- sorting by the records' own
 * declared timestamps, rather than trusting the caller's array position, is what makes both true
 * at once. */
function compareByOccurredAt(a: ReleaseEvent, b: ReleaseEvent): number {
  const ta = Date.parse(a.occurred_at);
  const tb = Date.parse(b.occurred_at);
  if (ta !== tb) return ta - tb;
  if (a.event_id === b.event_id) return 0;
  return a.event_id < b.event_id ? -1 : 1;
}

/** Folds every `release_event` record in the pool bound to `bundleDigest` (contracts.ts has
 * already validated each one's content against release-evidence/v0's event schema, so casting to
 * `ReleaseEvent` is safe) through the release-evidence/v0 D5 transition graph
 * (`src/core/fold.ts`'s `foldAttempt` -- the same pure function `src/core/collection.ts` uses for
 * the real CLI's own ledger fold; no fs, safe to import into shadow core). terra review round C,
 * must-1 residual: "ledger verifier が illegal_transition で reject する孤立 verified/preview が
 * preview_verified=satisfied" / "孤立 production deploy の illegal_transition" -- a release_event
 * that individually parses is not, by itself, legitimate evidence; it must also be reachable from
 * "(none)" via a legal sequence of this SAME attempt's other recorded events (sorted by
 * `occurred_at`, not array position). `evalPreviewVerified`/`evalRollbackTargetValid` consult
 * `legal`/`reachedProduction` before ever returning `satisfied`. */
function foldAttemptEvents(
  releaseId: string,
  bundleDigest: string,
  pool: ResolvedRecordPool,
): { legal: boolean; reachedProduction: boolean } {
  const events: ReleaseEvent[] = [];
  for (const record of pool.byDigest.values()) {
    if (record.kind !== "release_event") continue;
    const content = record.content as ReleaseEvent;
    if (content.bundle_digest === bundleDigest) events.push(content);
  }
  events.sort(compareByOccurredAt);
  const { problems, reachedProduction } = foldAttempt(releaseId, bundleDigest, events);
  return { legal: problems.length === 0, reachedProduction };
}

/** Ledger-wide, collection-level semantic MUST that `foldAttemptEvents`'s own
 * bundle_digest-only grouping cannot see (terra round D re-audit, 2026-08-27: "collection 検証が
 * attempt fold の一部に留まっています... event を bundle_digest だけで収集し、reference
 * collection が行う release_id 整合性確認と ledger-wide event_id uniquenessを実行しません").
 * A 1:1 port of the two checks `src/core/collection.ts`'s `checkReleaseCollection` runs over its
 * `events` loop (`release_id_mismatch` / `bundle_digest_unresolved`) and `src/core/fold.ts`'s
 * `foldLedger` runs ledger-wide (`duplicate_event_id`) -- reimplemented here rather than imported
 * because both reference functions take a fully-typed `{bundles, events}` collection assembled
 * from validated arrays, not this evaluator's digest-addressed `ResolvedRecordPool`.
 *
 * Runs over EVERY `release_event` record in the WHOLE pool, not just the ones bound to the
 * subject bundle's own digest -- `foldAttemptEvents` groups by `bundle_digest` alone, so an
 * attacker-controlled `release_id` on those same events (three events all claiming
 * `release_id="attacker-release"` while carrying the real bundle's digest), or one `event_id`
 * reused across events that individually parse fine, never surfaced anywhere: neither predicate
 * ever asks "does this event's OWN release_id agree with the bundle it claims to belong to" or
 * "is this event_id unique across the ledger", so `preview_verified`/`rollback_target_valid`
 * would still call the attempt `satisfied` on the strength of events that reference's own
 * collection-level checks reject outright.
 *
 * A violation is reported as `record_invalid` and short-circuits the WHOLE evaluation to
 * `invalid_input` -- the same outcome resolver.ts's own per-record `errors` already produce for a
 * tampered/inconsistent record -- because this is a ledger-wide trust question (an attacker who
 * controls the `release_id` or `event_id` field of an otherwise schema-valid event has broken the
 * ENTIRE evaluation's provenance, not just one predicate's evidence), never a single predicate's
 * `unknown`. This is a stronger remedy than round C's own `foldAttemptEvents` (illegal_transition
 * demotes only the one predicate to `unknown`, a deliberate choice recorded in
 * implement-notes.md to avoid rejecting `fullyResolvedInput`-style fixtures whose event chains are
 * intentionally incomplete for narrower predicate tests) -- but a legitimate fixture's events
 * always agree with their own bundle's `release_id` and never reuse an `event_id`, so this check's
 * blast radius is confined to genuinely inconsistent ledgers.
 *
 * terra round E must-1: the ② event_id uniqueness check below counts `pool.allOccurrences` (every
 * raw release_event OCCURRENCE that survived cut/digest/contract validation, duplicates by digest
 * kept), never `pool.byDigest.values()` (one survivor per distinct digest). The reference
 * `src/core/fold.ts` `foldLedger` folds `input.records` directly and rejects two occurrences that
 * share an `event_id` regardless of whether their content happens to be byte-identical; counting
 * only distinct digests silently swallowed the exact-duplicate case (the SAME record pushed twice
 * into `records[]` collapses to one `byDigest` entry, so its `event_id` was never seen twice). ①
 * release_id consistency stays digest-keyed (`pool.byDigest.values()`) -- it is a property of
 * content alone, so checking each distinct digest once is sufficient and avoids reporting the
 * same violation twice for a duplicated occurrence. */
function validateEventCollectionSemantics(pool: ResolvedRecordPool): InputError[] {
  const errors: InputError[] = [];
  const eventsByDigest: Array<{ digest: string; event: ReleaseEvent }> = [];
  for (const rec of pool.byDigest.values()) {
    if (rec.kind !== "release_event") continue;
    eventsByDigest.push({ digest: rec.digest, event: rec.content as ReleaseEvent });
  }

  // ① event.release_id vs. the release_id of the bundle its OWN bundle_digest resolves to
  // (core/collection.ts's release_id_mismatch). An event whose bundle_digest does not resolve to
  // a release_evidence_bundle record at all is not this check's concern -- that is each
  // predicate's own referent_unresolved territory (evalVerificationCoverage et al.).
  for (const { digest, event } of eventsByDigest) {
    const bundleRecord = resolveByDigest(pool, event.bundle_digest);
    if (!bundleRecord || bundleRecord.kind !== "release_evidence_bundle") continue;
    const bundle = parseBundleLike(bundleRecord.content);
    if (bundle && bundle.release_id !== event.release_id) {
      errors.push(
        inputError("record_invalid", {
          kind: "release_event",
          digest,
          reason: "release_id_mismatch",
          event_release_id: event.release_id,
          bundle_release_id: bundle.release_id,
        }),
      );
    }
  }

  // ② ledger-wide event_id uniqueness (core/fold.ts's foldLedger duplicate_event_id), across
  // every release_event OCCURRENCE in the pool (not deduplicated by digest -- see doc comment
  // above) -- not only the ones tied to the subject's own attempt.
  const eventIdOccurrenceCounts = new Map<string, number>();
  for (const rec of pool.allOccurrences) {
    if (rec.kind !== "release_event") continue;
    const eventId = (rec.content as ReleaseEvent).event_id;
    eventIdOccurrenceCounts.set(eventId, (eventIdOccurrenceCounts.get(eventId) ?? 0) + 1);
  }
  for (const [eventId, count] of eventIdOccurrenceCounts) {
    if (count > 1) {
      errors.push(
        inputError("record_invalid", {
          kind: "release_event",
          reason: "duplicate_event_id",
          event_id: eventId,
        }),
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Predicate evaluation
// ---------------------------------------------------------------------------

interface EvalContext {
  input: ShadowEvaluationInput;
  pool: ResolvedRecordPool;
  bundleRecord: ExactRecord;
  bundle: BundleLike | null;
  policySnapshot: ExactRecord | null;
}

/** Resolves the input-pointer table's "policy ref" (sol 裁定: "policy ref | 評価開始時の policy
 * snapshot") -- `input.policy.digest` against a `policy_snapshot`-kind record in the pool,
 * kind-checked the same way must-2's review/rollback pointer chains are (a record that happens to
 * share this digest but has a different `kind` never counts as resolved -- terra review must-2's
 * own "kind一致だけでsatisfiedにしない" discipline, applied here too).
 *
 * `input.policy.digest === null` (the schema-required, honest "no policy snapshot" declaration --
 * `input.ts`'s `absent_reason`) is the ONLY case this function itself treats as non-gating: it
 * returns `null` for it without ever attempting a lookup, the same "intentionally absent, not
 * missing" distinction `evalVerificationCoverage`'s `lane_ref_omitted` branch already draws -- no
 * predicate in this evaluator reads policy_snapshot CONTENT today (`privilege_boundary`'s own gap
 * is a missing static-scan CAPABILITY, tracked separately -- not a missing policy-DATA gap), so an
 * absent policy ref must never block or change today's evaluation (spec.md "捏造せず正直に" cuts
 * both ways -- fabricating a fake resolution is as wrong as fabricating a fake blocker).
 *
 * A NON-null digest, by contrast, IS gating (terra review round C, must-2 residual: "「未解決でも
 * 黙って receipt 生成」経路を削除"): it must resolve to a `policy_snapshot`-kind record, or
 * `evaluate()`'s own third wrapper gate rejects the whole evaluation before this function is ever
 * reached with it (evaluation_status="unknown", reason=referent_unresolved, same discipline as
 * `subject.bundle_digest`). By the time this function runs with a non-null digest, that gate has
 * already passed, so the `!record` branch below is unreachable in practice and kept only as
 * defense-in-depth (terra round D: this comment previously described that gate's NON-null
 * unresolved case as "never block[ing] or chang[ing]" the evaluation too, which stopped being
 * true the moment the round C wrapper gate was added -- corrected here to say which of the two
 * branches, digest===null vs. non-null, is actually the non-gating one).
 *
 * This function exists so a FUTURE predicate that DOES depend on policy content has a real
 * pointer chain to resolve against, under one documented rule: an unresolved policy ref must make
 * that predicate's policy-dependent part unknown/not_yet_recorded, never a fabricated satisfied
 * (spec.md "捏造せず正直に") -- exercised by this function's own regression tests (resolve /
 * wrong-kind / unresolved), not yet by any predicate. */
export function resolvePolicySnapshot(
  input: ShadowEvaluationInput,
  pool: ResolvedRecordPool,
): ExactRecord | null {
  if (input.policy.digest === null) return null;
  const record = resolveByDigest(pool, input.policy.digest);
  if (!record || record.kind !== "policy_snapshot") return null;
  return record;
}

/** The one evidence citation shape sol's design log gives explicitly (verification_coverage),
 * generalized here to every predicate that has no resolvable-kind evidence of its own: cite the
 * bundle under evaluation itself. This is a deliberate, documented generalization -- see
 * implement-notes.md -- covering the known contract gap (promotion-receipt/v0 cannot bind a
 * preview event or rollback history directly; only `review_finding` and `release_evidence` are
 * resolvable evidence_refs.kind values, so anything derived from a `release_event` record has to
 * cite the bundle whose lifecycle that event belongs to, never the event itself). */
function bundleEvidenceRef(ctx: EvalContext): EvidenceRef {
  return {
    kind: "release_evidence",
    ref: ctx.bundle?.release_id ?? ctx.bundleRecord.digest,
    digest: ctx.input.subject.bundle_digest,
  };
}

/** evidence_refs entry for a review_admissibility predicate grounded via the review-finding
 * pointer chain (terra review must-2). `ref` prefers the resolved record's own `record_id` when
 * the content parses that far, falling back to the digest itself -- the same "best identity
 * available" pattern bundleEvidenceRef already uses for the bundle's release_id. */
function reviewFindingEvidenceRef(findingRecord: ExactRecord, digest: string): EvidenceRef {
  const content = findingRecord.content as Record<string, unknown> | null;
  const recordId = content && typeof content.record_id === "string" ? content.record_id : digest;
  return { kind: "review_finding", ref: recordId, digest };
}

const STRUCTURAL_BUNDLE_UNKNOWN = () =>
  unknownReason("unknown_structural", {
    detail:
      "resolved release_evidence_bundle record content did not parse as a release-evidence/v0 bundle",
  });

function evalArtifactIdentity(ctx: EvalContext): PredicateObservation {
  const wellFormed = ctx.bundleRecord.kind === "release_evidence_bundle" && ctx.bundle !== null;
  if (wellFormed) {
    return {
      predicate_id: "artifact_identity",
      applicability: "applicable",
      status: "satisfied",
      evidence_refs: [bundleEvidenceRef(ctx)],
    };
  }
  return {
    predicate_id: "artifact_identity",
    applicability: "applicable",
    status: "contradicted",
    evidence_refs: [bundleEvidenceRef(ctx)],
    notes: `record resolved at subject.bundle_digest has kind "${ctx.bundleRecord.kind}" and/or does not parse as a release-evidence/v0 bundle -- the artifact's identity claim is not well-formed`,
  };
}

function evalReviewAdmissibility(ctx: EvalContext): PredicateObservation {
  if (!ctx.bundle) {
    return {
      predicate_id: "review_admissibility",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: STRUCTURAL_BUNDLE_UNKNOWN(),
    };
  }
  if (ctx.bundle.review !== null) {
    if (ctx.bundle.review.decision === "commented") {
      return {
        predicate_id: "review_admissibility",
        applicability: "applicable",
        status: "contradicted",
        evidence_refs: [bundleEvidenceRef(ctx)],
        notes:
          'bundle.review.decision is "commented" -- a comment is not an admissible review pass (same rule as src/core/gates.ts checkProductionGate)',
      };
    }
    // "approved" and "self_merged" both pass checkProductionGate's own already-frozen policy, but
    // that alone is just the bundle's OWN claim -- terra review must-2: "review は finding record
    // を参照せず bundle の decision だけで satisfied です". satisfied now also requires the
    // review-finding pointer chain (subject.review_finding_digest -> a resolved
    // review_finding_record) to actually ground that claim; without it this stays unknown, never
    // a silent pass.
    const findingDigest = ctx.input.subject.review_finding_digest ?? null;
    if (findingDigest === null) {
      return {
        predicate_id: "review_admissibility",
        applicability: "applicable",
        status: "unknown",
        evidence_refs: [],
        reason: unknownReason("referent_unresolved", {
          pointer: "subject.review_finding_digest",
          detail:
            "bundle.review.decision is non-null but no review-finding record pointer was given to ground it",
        }),
      };
    }
    const findingRecord = resolveByDigest(ctx.pool, findingDigest);
    if (!findingRecord) {
      return {
        predicate_id: "review_admissibility",
        applicability: "applicable",
        status: "unknown",
        evidence_refs: [],
        reason: unknownReason("referent_unresolved", {
          pointer: "subject.review_finding_digest",
          digest: findingDigest,
        }),
      };
    }
    if (findingRecord.kind !== "review_finding_record") {
      return {
        predicate_id: "review_admissibility",
        applicability: "applicable",
        status: "contradicted",
        evidence_refs: [bundleEvidenceRef(ctx)],
        notes: `record resolved at subject.review_finding_digest has kind "${findingRecord.kind}", expected "review_finding_record"`,
      };
    }
    return {
      predicate_id: "review_admissibility",
      applicability: "applicable",
      status: "satisfied",
      evidence_refs: [reviewFindingEvidenceRef(findingRecord, findingDigest)],
    };
  }
  // bundle.review === null: the bundle itself claims review was omitted (or is malformed and
  // omits both `review` and `review_omitted` -- either way, this evaluator does not have a
  // normalization rule that turns a review_omitted code into a satisfied/contradicted signal, so
  // this stays an honest unknown rather than a silent pass. review_admissibility is one of the
  // three always-on predicates (never not_applicable, promotion-receipt-v0.md), so a legitimate
  // omission is still `applicability=applicable`, exactly like verification_coverage's
  // lane_ref_omitted case.
  return {
    predicate_id: "review_admissibility",
    applicability: "applicable",
    status: "unknown",
    evidence_refs: [],
    reason: unknownReason("unknown_structural", {
      detail:
        "bundle.review is null (review omitted); this evaluator has no normalization rule for a review_omitted code",
      review_omitted_code: ctx.bundle.review_omitted_code,
    }),
  };
}

function evalVerificationCoverage(ctx: EvalContext): PredicateObservation {
  if (!ctx.bundle) {
    return {
      predicate_id: "verification_coverage",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: STRUCTURAL_BUNDLE_UNKNOWN(),
    };
  }
  if (ctx.bundle.lane_ref === null) {
    const omissionCode = (ctx.bundle.lane_ref_omitted_code ?? "other") as LaneRefOmittedCode;
    return {
      predicate_id: "verification_coverage",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: laneRefOmittedReason(omissionCode),
    };
  }
  const verificationDigest = ctx.bundle.lane_ref.verification_digest;
  const record = resolveByDigest(ctx.pool, verificationDigest);
  if (!record) {
    return {
      predicate_id: "verification_coverage",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: unknownReason("referent_unresolved", {
        pointer: "bundle.lane_ref.verification_digest",
        digest: verificationDigest,
      }),
    };
  }
  if (record.kind !== "verification_record") {
    return {
      predicate_id: "verification_coverage",
      applicability: "applicable",
      status: "contradicted",
      evidence_refs: [bundleEvidenceRef(ctx)],
      notes: `record resolved at bundle.lane_ref.verification_digest has kind "${record.kind}", expected "verification_record"`,
    };
  }
  return {
    predicate_id: "verification_coverage",
    applicability: "applicable",
    status: "satisfied",
    evidence_refs: [bundleEvidenceRef(ctx)],
  };
}

function evalPreviewVerified(ctx: EvalContext): PredicateObservation {
  if (!ctx.bundle) {
    return {
      predicate_id: "preview_verified",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: STRUCTURAL_BUNDLE_UNKNOWN(),
    };
  }
  const events = scanReleaseEvents(ctx.pool).filter(
    (e) => e.bundle_digest === ctx.input.subject.bundle_digest,
  );
  const previewSkipped = events.some(
    (e) => e.kind === "deployed" && e.environment === "production" && e.preview_skipped,
  );
  if (ctx.input.subject.target === "preview" || previewSkipped) {
    return {
      predicate_id: "preview_verified",
      applicability: "not_applicable",
      status: "unknown",
      evidence_refs: [],
      reason: unknownReason("not_applicable_by_policy", {
        detail: previewSkipped
          ? "a deployed/production release_event for this attempt recorded preview_skipped=true"
          : "subject.target is preview -- preview_verified is not a precondition of deploying to preview itself",
      }),
    };
  }
  const failed = events.some((e) => e.kind === "failed" && e.environment === "preview");
  if (failed) {
    return {
      predicate_id: "preview_verified",
      applicability: "applicable",
      status: "contradicted",
      evidence_refs: [bundleEvidenceRef(ctx)],
      notes: "a failed/preview release_event was recorded for this attempt",
    };
  }
  const verified = events.some((e) => e.kind === "verified" && e.environment === "preview");
  if (verified) {
    const fold = foldAttemptEvents(
      ctx.bundle.release_id,
      ctx.input.subject.bundle_digest,
      ctx.pool,
    );
    if (fold.legal) {
      return {
        predicate_id: "preview_verified",
        applicability: "applicable",
        status: "satisfied",
        evidence_refs: [bundleEvidenceRef(ctx)],
      };
    }
    // terra review round C: a verified/preview event was recorded, but this attempt's own
    // release_event history does not fold legally through the D5 transition graph (e.g. an
    // orphaned event with no preceding prepared/deployed) -- never trust it as satisfied evidence
    // just because it individually parses.
    return {
      predicate_id: "preview_verified",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: unknownReason("unknown_structural", {
        detail:
          "a verified/preview release_event was recorded for this attempt, but this attempt's own release_event history is not a legal release-evidence/v0 lifecycle (illegal transition in the D5 graph)",
      }),
    };
  }
  return {
    predicate_id: "preview_verified",
    applicability: "applicable",
    status: "unknown",
    evidence_refs: [],
    reason: unknownReason("not_yet_recorded", {
      detail:
        "no verified/preview release_event has been recorded for this attempt as of evaluation_cut",
    }),
  };
}

function evalRollbackTargetValid(ctx: EvalContext): PredicateObservation {
  if (!ctx.bundle) {
    return {
      predicate_id: "rollback_target_valid",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: STRUCTURAL_BUNDLE_UNKNOWN(),
    };
  }
  const target = ctx.bundle.rollback_previous_release_id;
  if (target === null) {
    return {
      predicate_id: "rollback_target_valid",
      applicability: "not_applicable",
      status: "unknown",
      evidence_refs: [],
      reason: unknownReason("not_applicable_by_policy", {
        detail:
          "bundle.rollback.previous_release_id is null -- this attempt names no rollback target",
      }),
    };
  }
  if (target === ctx.bundle.release_id) {
    return {
      predicate_id: "rollback_target_valid",
      applicability: "applicable",
      status: "contradicted",
      evidence_refs: [bundleEvidenceRef(ctx)],
      notes:
        "bundle.rollback.previous_release_id equals the bundle's own release_id (rollback_to_self)",
    };
  }
  // terra review must-2: "rollback は previous bundle を要求せず release ID が一致する event
  // だけで satisfied です" -- satisfied now requires resolving the ACTUAL previous bundle record
  // (subject.rollback_previous_bundle_digest, expected kind + whole-record digest) AND a
  // deployed/production event bound to THAT SPECIFIC bundle's own digest, not merely to a
  // release_id string that any event could claim.
  const previousBundleDigest = ctx.input.subject.rollback_previous_bundle_digest ?? null;
  if (previousBundleDigest === null) {
    return {
      predicate_id: "rollback_target_valid",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: unknownReason("referent_unresolved", {
        pointer: "subject.rollback_previous_bundle_digest",
        detail:
          "bundle.rollback.previous_release_id names a target but no previous-bundle pointer was given",
        release_id: target,
      }),
    };
  }
  const previousBundleRecord = resolveByDigest(ctx.pool, previousBundleDigest);
  if (!previousBundleRecord) {
    return {
      predicate_id: "rollback_target_valid",
      applicability: "applicable",
      status: "unknown",
      evidence_refs: [],
      reason: unknownReason("referent_unresolved", {
        pointer: "subject.rollback_previous_bundle_digest",
        digest: previousBundleDigest,
      }),
    };
  }
  if (previousBundleRecord.kind !== "release_evidence_bundle") {
    return {
      predicate_id: "rollback_target_valid",
      applicability: "applicable",
      status: "contradicted",
      evidence_refs: [bundleEvidenceRef(ctx)],
      notes: `record resolved at subject.rollback_previous_bundle_digest has kind "${previousBundleRecord.kind}", expected "release_evidence_bundle"`,
    };
  }
  const previousBundle = parseBundleLike(previousBundleRecord.content);
  if (!previousBundle || previousBundle.release_id !== target) {
    return {
      predicate_id: "rollback_target_valid",
      applicability: "applicable",
      status: "contradicted",
      evidence_refs: [bundleEvidenceRef(ctx)],
      notes:
        "record resolved at subject.rollback_previous_bundle_digest does not parse as a release-evidence/v0 bundle whose release_id matches bundle.rollback.previous_release_id",
    };
  }
  // terra review round C: a deployed/production event bound to the previous bundle's own digest
  // is not, by itself, legitimate evidence -- it must also be reachable from "(none)" via a
  // legal D5 transition sequence of THIS previous attempt's own recorded events (a lone
  // "deployed|production" with no preceding "prepared" is exactly the "孤立 production deploy"
  // illegal_transition terra's re-audit reproduced).
  const fold = foldAttemptEvents(target, previousBundleRecord.digest, ctx.pool);
  if (fold.legal && fold.reachedProduction) {
    return {
      predicate_id: "rollback_target_valid",
      applicability: "applicable",
      status: "satisfied",
      evidence_refs: [bundleEvidenceRef(ctx)],
    };
  }
  return {
    predicate_id: "rollback_target_valid",
    applicability: "applicable",
    status: "unknown",
    evidence_refs: [],
    reason: unknownReason("referent_unresolved", {
      pointer: "release_event.bundle_digest",
      digest: previousBundleRecord.digest,
      detail:
        "no deployed/production event is bound to the previous bundle's own digest via a legal release-evidence/v0 lifecycle (either none is recorded, or this attempt's release_event history does not fold legally through the D5 transition graph)",
    }),
  };
}

/** promotion-receipt-v0.md "Caveats this contract is honest about": a satisfied
 * privilege_boundary can only ever reflect what a static configuration scan proves, never a full
 * security guarantee. This evaluator implements no such scan at all yet (no exact-record kind in
 * this evaluator's input model represents CI/workflow configuration) -- so the predicate is
 * always the honest unknown, spec.md's own instruction ("観測の note に機械的に含める") applied
 * literally: the caveat note is attached unconditionally, not only when a future scan succeeds. */
const PRIVILEGE_BOUNDARY_NOTE =
  'privilege_boundary\'s static scan, once implemented, is a necessary condition, not a sufficient one (promotion-receipt-v0.md "Caveats"). This evaluator does not implement any configuration scan yet, so this predicate is never fabricated as satisfied.';

function evalPrivilegeBoundary(): PredicateObservation {
  return {
    predicate_id: "privilege_boundary",
    applicability: "applicable",
    status: "unknown",
    evidence_refs: [],
    reason: unknownReason("unknown_structural", {
      detail: "no static configuration scan is implemented by this evaluator",
    }),
    notes: PRIVILEGE_BOUNDARY_NOTE,
  };
}

function evaluatePredicate(id: PrePromotionPredicateId, ctx: EvalContext): PredicateObservation {
  switch (id) {
    case "artifact_identity":
      return evalArtifactIdentity(ctx);
    case "review_admissibility":
      return evalReviewAdmissibility(ctx);
    case "verification_coverage":
      return evalVerificationCoverage(ctx);
    case "preview_verified":
      return evalPreviewVerified(ctx);
    case "rollback_target_valid":
      return evalRollbackTargetValid(ctx);
    case "privilege_boundary":
      return evalPrivilegeBoundary();
  }
}

// ---------------------------------------------------------------------------
// Candidate receipt assembly
// ---------------------------------------------------------------------------

/** Mechanical projection (spec.md: "別ロジックで再計算しない") -- drops `reason` (not part of
 * promotion-receipt/v0's own predicate shape) and copies everything else verbatim. Exported for
 * verify.ts's `verifyPredicateProjection` (terra review must-5: "wrapper 側にも...
 * observation→receipt projection の照合関数を用意"), which recomputes this same projection from
 * `ShadowEvaluation.predicate_observations` and compares it against the stored
 * `candidate_receipt.predicates` rather than trusting the two arrays stayed in sync. */
export function toReceiptPredicate(observation: PredicateObservation): ReceiptPredicate {
  const predicate: ReceiptPredicate = {
    predicate_id: observation.predicate_id,
    applicability: observation.applicability,
    status: observation.status,
    evidence_refs: observation.evidence_refs,
  };
  if (observation.notes !== undefined) predicate.notes = observation.notes;
  return predicate;
}

function deriveVerdict(predicates: readonly ReceiptPredicate[]): CandidateReceipt["verdict"] {
  const applicable = predicates.filter((p) => p.applicability === "applicable");
  if (applicable.some((p) => p.status === "contradicted")) return "ineligible";
  if (applicable.some((p) => p.status === "unknown")) return "abstained";
  return "ready_for_approval";
}

function buildCandidateReceipt(
  input: ShadowEvaluationInput,
  observations: readonly PredicateObservation[],
  inputManifestDigest: string,
): CandidateReceipt {
  const predicates = observations.map(toReceiptPredicate);
  const verdict = deriveVerdict(predicates);
  const receiptId = deriveReceiptId({
    inputManifestDigest,
    evaluatorVersion: SHADOW_EVALUATOR_VERSION,
    phase: "pre_promotion",
  });

  // A plain object literal (not cast to CandidateReceipt) so computeSemanticDigest -- which
  // strips evaluated_at/receipt_id/semantic_digest before hashing -- can be called BEFORE the
  // real semantic_digest is known; the placeholder "" is never part of the hashed bytes either
  // way (see computeSemanticDigest's doc comment), so its exact value here is immaterial.
  const draft = {
    schema_version: "promotion-receipt/v0" as const,
    receipt_id: receiptId,
    evaluated_at: input.evaluation_cut,
    evaluation_phase: "pre_promotion" as const,
    subject: {
      bundle_digest: input.subject.bundle_digest,
      selection_manifest_digest: input.subject.selection_manifest_digest,
      target: input.subject.target,
    },
    policy_digest: input.policy.digest ?? POLICY_DIGEST_ABSENT_SENTINEL,
    effective_risk: input.policy.effective_risk,
    semantic_digest: "",
    predicates,
    verdict,
  };
  return { ...draft, semantic_digest: computeSemanticDigest(draft) };
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

interface WrapperFields {
  evaluation_status: ShadowEvaluation["evaluation_status"];
  unknown_reasons: ShadowEvaluation["unknown_reasons"];
  input_errors: ShadowEvaluation["input_errors"];
  predicate_observations: ShadowEvaluation["predicate_observations"];
  candidate_receipt: ShadowEvaluation["candidate_receipt"];
}

function finalize(
  input: ShadowEvaluationInput,
  inputManifestRecords: Array<{ kind: string; digest: string }>,
  inputManifestDigest: string,
  fields: WrapperFields,
): ShadowEvaluation {
  // Plain object literal, not cast to ShadowEvaluation, for the same reason as buildCandidateReceipt's
  // `draft` above -- computeRecordDigest strips record_digest before hashing, so the "" placeholder
  // here is never part of the hashed bytes.
  const draft = {
    schema_version: "shadow-evaluation/v0" as const,
    mode: "shadow_only" as const,
    evaluation_cut: input.evaluation_cut,
    evaluator: {
      version: SHADOW_EVALUATOR_VERSION,
      playbook_contract_commit: input.contract_pin.playbook_commit,
    },
    input_manifest: { records: inputManifestRecords, digest: inputManifestDigest },
    record_digest: "",
    ...fields,
  };
  return { ...draft, record_digest: computeRecordDigest(draft) };
}

/** Pure evaluation core (spec.md: `evaluate(input): ShadowEvaluation`). `evaluation_cut`,
 * policy, risk, and contract pin are all read from `input`, never from any ambient clock/env. */
export function evaluate(input: ShadowEvaluationInput): ShadowEvaluation {
  const pool = resolveRecordPool(input.records, input.evaluation_cut);

  // input_manifest reflects the record set actually AVAILABLE for this evaluation to consume
  // (digest-verified, cut-filtered) -- never the raw, unfiltered input.records, and never a
  // record excluded as future (spec.md hindsight-leakage ban: a record this evaluation was not
  // allowed to look at must not appear as if it grounded the output).
  const inputManifestRecords = sortInputManifestRefs(
    [...pool.byDigest.values()].map((r) => ({ kind: r.kind, digest: r.digest })),
  );
  const inputManifestDigest = computeInputManifestDigest(inputManifestRecords);

  if (pool.errors.length > 0) {
    return finalize(input, inputManifestRecords, inputManifestDigest, {
      evaluation_status: "invalid_input",
      unknown_reasons: [],
      input_errors: sortInputErrors(pool.errors),
      predicate_observations: [],
      candidate_receipt: null,
    });
  }

  // terra round D: collection-level semantic MUST (release_id consistency + ledger-wide
  // event_id uniqueness) that resolver.ts's per-record validation cannot see on its own -- see
  // validateEventCollectionSemantics's doc comment. Checked before any wrapper gate or predicate
  // ever reads a release_event, same short-circuit priority as pool.errors above.
  const collectionErrors = validateEventCollectionSemantics(pool);
  if (collectionErrors.length > 0) {
    return finalize(input, inputManifestRecords, inputManifestDigest, {
      evaluation_status: "invalid_input",
      unknown_reasons: [],
      input_errors: sortInputErrors(collectionErrors),
      predicate_observations: [],
      candidate_receipt: null,
    });
  }

  // Required-subject existence gates (spec.md: candidate_receipt only when "receipt の必須
  // subject が全て実在する"). Kind-correctness of what resolves is each predicate's own concern
  // (most visibly artifact_identity's) -- these two gates only ask "does anything resolve here
  // at all".
  const manifestRecord = resolveByDigest(pool, input.subject.selection_manifest_digest);
  if (!manifestRecord || manifestRecord.kind !== "selection_manifest") {
    return finalize(input, inputManifestRecords, inputManifestDigest, {
      evaluation_status: "unknown",
      unknown_reasons: [
        unknownReason("unknown_structural", {
          detail: !manifestRecord
            ? "subject.selection_manifest_digest does not resolve in the given exact-record pool"
            : `record resolved at subject.selection_manifest_digest has kind "${manifestRecord.kind}", expected "selection_manifest" (terra review must-2: kind一致だけでsatisfiedにしない)`,
          digest: input.subject.selection_manifest_digest,
        }),
      ],
      input_errors: [],
      predicate_observations: [],
      candidate_receipt: null,
    });
  }

  const bundleRecord = resolveByDigest(pool, input.subject.bundle_digest);
  if (!bundleRecord) {
    return finalize(input, inputManifestRecords, inputManifestDigest, {
      evaluation_status: "unknown",
      unknown_reasons: [
        unknownReason("referent_unresolved", {
          pointer: "subject.bundle_digest",
          digest: input.subject.bundle_digest,
        }),
      ],
      input_errors: [],
      predicate_observations: [],
      candidate_receipt: null,
    });
  }

  // terra review round C, must-2 residual: a non-null policy.digest is now a real pointer that
  // MUST resolve, the same discipline subject.bundle_digest already gets -- "「未解決でも黙って
  // receipt 生成」経路を削除". `digest === null` is the honest, schema-required "no policy
  // snapshot" declaration (input.ts's `absent_reason`) and is never gated here.
  if (input.policy.digest !== null) {
    const policyRecord = resolveByDigest(pool, input.policy.digest);
    if (!policyRecord || policyRecord.kind !== "policy_snapshot") {
      return finalize(input, inputManifestRecords, inputManifestDigest, {
        evaluation_status: "unknown",
        unknown_reasons: [
          unknownReason("referent_unresolved", {
            pointer: "policy.digest",
            digest: input.policy.digest,
            detail: !policyRecord
              ? "policy.digest does not resolve in the given exact-record pool"
              : `record resolved at policy.digest has kind "${policyRecord.kind}", expected "policy_snapshot"`,
          }),
        ],
        input_errors: [],
        predicate_observations: [],
        candidate_receipt: null,
      });
    }
  }

  const ctx: EvalContext = {
    input,
    pool,
    bundleRecord,
    bundle: parseBundleLike(bundleRecord.content),
    policySnapshot: resolvePolicySnapshot(input, pool),
  };
  const observations = PRE_PROMOTION_PREDICATE_IDS.map((id) => evaluatePredicate(id, ctx));
  const candidateReceipt = buildCandidateReceipt(input, observations, inputManifestDigest);

  return finalize(input, inputManifestRecords, inputManifestDigest, {
    evaluation_status: "evaluated",
    unknown_reasons: [],
    input_errors: [],
    predicate_observations: observations,
    candidate_receipt: candidateReceipt,
  });
}
