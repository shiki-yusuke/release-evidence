// Wrapper-side self-consistency verifiers (terra review must-5, 2026-08-27: "wrapper 側にも
// record_digest / input_manifest digest / observation→receipt projection の照合関数を用意しテス
// ト"). Each function here RECOMPUTES one of `ShadowEvaluation`'s own self-digests (or its own
// mechanical projection) from the rest of the object and compares -- the same "recompute and
// compare, never trust the stored value" discipline serialize.ts's own doc comment already
// describes, exposed as three named, independently testable predicates instead of leaving each
// call site to inline its own ad-hoc comparison (which is what test/shadow-tamper.test.ts did
// before this round).
//
// Pure -- no fs/network/process.env/Date.now()/argument-less new Date() (spec.md "決定論"), same
// discipline as every other file in src/shadow/**.

import { canonicalize } from "#vendor/jcs.mjs";
import { toReceiptPredicate } from "./evaluate.js";
import type { ShadowEvaluation } from "./input.js";
import { computeInputManifestDigest, computeRecordDigest } from "./serialize.js";

/** True when `evaluation.record_digest` matches a fresh recomputation over the rest of the
 * object -- catches an attacker (or a bug) that edits any field and leaves the old
 * `record_digest` in place, exactly the ⑥ shadow-tamper scenario. */
export function verifyRecordDigest(evaluation: ShadowEvaluation): boolean {
  const recomputed = computeRecordDigest(evaluation as unknown as Record<string, unknown>);
  return recomputed === evaluation.record_digest;
}

/** True when `evaluation.input_manifest.digest` matches a fresh recomputation over
 * `evaluation.input_manifest.records` -- `computeInputManifestDigest` sorts its own input by
 * (kind, digest) internally, so this is correct regardless of the stored records' own order. */
export function verifyInputManifestDigest(evaluation: ShadowEvaluation): boolean {
  const recomputed = computeInputManifestDigest(evaluation.input_manifest.records);
  return recomputed === evaluation.input_manifest.digest;
}

/** True when `evaluation.candidate_receipt.predicates` is exactly the mechanical projection
 * (`toReceiptPredicate`) of `evaluation.predicate_observations`, recomputed fresh rather than
 * assumed to still match -- catches a predicate dropped, duplicated, or edited between the two
 * arrays without the corresponding field being kept in sync. `null` receipts are only valid when
 * there are zero observations to project (the same invariant `evaluate.ts` itself maintains). */
export function verifyPredicateProjection(evaluation: ShadowEvaluation): boolean {
  if (evaluation.candidate_receipt === null) return evaluation.predicate_observations.length === 0;
  const projected = evaluation.predicate_observations.map(toReceiptPredicate);
  return canonicalize(projected) === canonicalize(evaluation.candidate_receipt.predicates);
}
