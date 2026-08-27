// Tamper-injection tests (chunk 3, spec.md test plan item 3: "改ざん注入: bundle 1 byte /
// finding claim / verification record / pointer digest 差し替え / candidate receipt の predicate
// 欠落・重複 / shadow output の record_digest 差し替え"). Each scenario below is a distinct attack
// shape, and each is caught by a distinct mechanism -- this file exists to make that mapping
// explicit in one place, even though some individual mechanisms already have coverage elsewhere
// (shadow-evaluate.test.ts / shadow-cli.test.ts):
//
//   ① bundle content edited without updating its own declared digest, ② same for a
//   review_finding_record, ③ same for a verification_record that IS actually consulted by
//   evaluate() -- all three are caught the same way: resolveRecordPool (resolver.ts) recomputes
//   every record's content digest and reports a mismatch as an InputError, regardless of which
//   exact-record kind was tampered or whether evaluate() even reads that record's content.
//
//   ④ a POINTER value inside otherwise-untampered content is swapped to a digest nothing in the
//   pool has -- a fundamentally different attack from ①-③ (every record's own digest is still
//   internally consistent; what's wrong is which record a *reference* names). This is never an
//   InputError -- it surfaces as the referencing predicate's own honest `unknown`/
//   `referent_unresolved`, never a silent pass.
//
//   ⑤ and ⑥ attack the EVALUATOR'S OWN OUTPUT after the fact (not the input it was computed
//   from) -- exactly the scenario promotion-receipt/v0's semantic_digest (R12) and this
//   evaluator's own record_digest exist to make detectable: a downstream verifier recomputes the
//   digest from the (possibly-edited) object and compares, rather than trusting whatever value is
//   stored alongside it. Both `computeSemanticDigest` and `computeRecordDigest` (src/shadow/
//   serialize.ts) strip only their own digest field (and, for semantic_digest, evaluated_at/
//   receipt_id) before hashing -- so editing ANYTHING else and leaving the old digest in place is
//   exactly what a recompute-and-compare catches, without needing a separate "predicate
//   completeness" check: dropping or duplicating a predicate changes the hashed bytes just like
//   editing any other field would.

import { describe, expect, it } from "vitest";
import { checkReceiptAgainstVendoredVerifier } from "../src/shadow-cli/vendor-loader.js";
import { evaluate } from "../src/shadow/evaluate.js";
import type {
  CandidateReceipt,
  ExactRecord,
  ShadowEvaluation,
  ShadowEvaluationInput,
} from "../src/shadow/input.js";
import { validateShadowEvaluation } from "../src/shadow/input.js";
import {
  computeRecordDigest,
  computeSemanticDigest,
  recordContentDigest,
} from "../src/shadow/serialize.js";
import {
  verifyInputManifestDigest,
  verifyPredicateProjection,
  verifyRecordDigest,
} from "../src/shadow/verify.js";
import {
  validBundleContent,
  validReviewFindingContent,
  validVerificationRecordContent,
} from "./helpers.js";

const HEX_DIGITS = "0123456789abcdef";
const SHA = (label: string) => `sha256:${(HEX_DIGITS[label.charCodeAt(0) % 16] ?? "0").repeat(64)}`;

function record(kind: ExactRecord["kind"], content: unknown, observed_at?: string): ExactRecord {
  const digest = recordContentDigest(content);
  return observed_at ? { kind, digest, content, observed_at } : { kind, digest, content };
}

const EVALUATION_CUT = "2026-08-23T00:00:00Z";
const VERIFICATION_CONTENT = validVerificationRecordContent("v-1");
const VERIFICATION_DIGEST = recordContentDigest(VERIFICATION_CONTENT);
const BUNDLE_CONTENT = validBundleContent({
  release_id: "spec-lane@0.7.0",
  lane_ref: { verification_digest: VERIFICATION_DIGEST },
  review: { decision: "approved" },
  rollback_previous_release_id: null,
});
const REVIEW_FINDING_CONTENT = validReviewFindingContent({
  record_id: "rf-1",
  recorded_at: EVALUATION_CUT,
});

function baseInput(
  records: ExactRecord[],
  bundleDigest: string,
  manifestDigest: string,
  reviewFindingDigest?: string,
): ShadowEvaluationInput {
  return {
    schema_version: "shadow-evaluation-input/v0",
    evaluation_cut: EVALUATION_CUT,
    // round C: an honest "no policy snapshot" declaration, not a placeholder digest that
    // happens not to resolve -- a non-null digest is now a wrapper-level gate (evaluate.ts).
    policy: {
      digest: null,
      absent_reason: { code: "policy_snapshot_absent", note: "test fixture default" },
      effective_risk: "medium",
    },
    contract_pin: { playbook_commit: "f9f0c127588f60fd299a02859c9f70f0b81a9dcc" },
    subject: {
      bundle_digest: bundleDigest,
      selection_manifest_digest: manifestDigest,
      target: "production",
      review_finding_digest: reviewFindingDigest ?? null,
    },
    records,
  };
}

function fullPool(): {
  manifest: ExactRecord;
  bundle: ExactRecord;
  verification: ExactRecord;
  reviewFinding: ExactRecord;
} {
  return {
    manifest: record("selection_manifest", { manifest_id: "sm-1" }),
    bundle: record("release_evidence_bundle", BUNDLE_CONTENT),
    verification: record("verification_record", VERIFICATION_CONTENT),
    reviewFinding: record("review_finding_record", REVIEW_FINDING_CONTENT, EVALUATION_CUT),
  };
}

describe("tamper injection: record content edited, declared digest left stale (① bundle / ② review finding / ③ verification record)", () => {
  it("① bundle content edited by one field, digest left stale -> evaluation_status=invalid_input, input_errors=[digest_mismatch]", () => {
    const { manifest, bundle, verification, reviewFinding } = fullPool();
    const tamperedBundle: ExactRecord = {
      ...bundle,
      content: { ...BUNDLE_CONTENT, release_id: "spec-lane@0.7.0-TAMPERED" },
    };
    const input = baseInput(
      [manifest, tamperedBundle, verification, reviewFinding],
      bundle.digest,
      manifest.digest,
    );
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "digest_mismatch",
        params: expect.objectContaining({ kind: "release_evidence_bundle" }),
      }),
    ]);
    expect(result.candidate_receipt).toBeNull();
  });

  it("② review_finding_record claim edited, digest left stale -> evaluation_status=invalid_input, input_errors=[digest_mismatch] (caught even though evaluate() never reads this record's content today)", () => {
    const { manifest, bundle, verification, reviewFinding } = fullPool();
    const tamperedFinding: ExactRecord = {
      ...reviewFinding,
      content: {
        ...REVIEW_FINDING_CONTENT,
        findings: [{ finding_id: "f-1", claim: "claim replaced by an attacker" }],
      },
    };
    const input = baseInput(
      [manifest, bundle, verification, tamperedFinding],
      bundle.digest,
      manifest.digest,
    );
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "digest_mismatch",
        params: expect.objectContaining({ kind: "review_finding_record" }),
      }),
    ]);
    expect(result.candidate_receipt).toBeNull();
  });

  it("③ verification_record content edited, digest left stale -> evaluation_status=invalid_input, input_errors=[digest_mismatch] (this record IS consulted, via bundle.lane_ref.verification_digest)", () => {
    const { manifest, bundle, verification, reviewFinding } = fullPool();
    const tamperedVerification: ExactRecord = {
      ...verification,
      content: { ...VERIFICATION_CONTENT, verification_id: "v-1-TAMPERED" },
    };
    const input = baseInput(
      [manifest, bundle, tamperedVerification, reviewFinding],
      bundle.digest,
      manifest.digest,
    );
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "digest_mismatch",
        params: expect.objectContaining({ kind: "verification_record" }),
      }),
    ]);
    expect(result.candidate_receipt).toBeNull();
  });
});

describe("tamper injection: ④ pointer digest substituted (record pool itself untampered)", () => {
  it("bundle.lane_ref.verification_digest swapped to a digest nothing in the pool has -> verification_coverage stays evaluated but unknown/referent_unresolved, never a silent pass", () => {
    const { manifest, bundle, verification, reviewFinding } = fullPool();
    const swappedContent = validBundleContent({
      release_id: "spec-lane@0.7.0",
      lane_ref: { verification_digest: SHA("attacker-substituted") },
      review: { decision: "approved" },
      rollback_previous_release_id: null,
    });
    const swappedBundle: ExactRecord = {
      kind: "release_evidence_bundle",
      digest: recordContentDigest(swappedContent),
      content: swappedContent,
    };
    const input = baseInput(
      [manifest, swappedBundle, verification, reviewFinding],
      swappedBundle.digest,
      manifest.digest,
    );
    const result = evaluate(input);
    // The pool itself is fully consistent (every record's declared digest matches its content) --
    // this is NOT invalid_input. The substitution only surfaces as one predicate's own honest
    // unknown.
    expect(result.evaluation_status).toBe("evaluated");
    expect(result.input_errors).toEqual([]);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "verification_coverage",
    );
    expect(observation).toMatchObject({
      status: "unknown",
      applicability: "applicable",
      reason: expect.objectContaining({
        code: "referent_unresolved",
        params: expect.objectContaining({ digest: SHA("attacker-substituted") }),
      }),
    });
  });
});

describe("tamper injection: ⑤ candidate_receipt predicate missing/duplicated, semantic_digest RECOMPUTED to match (terra review must-5, 2026-08-27: 'digest が変わった' 比較ではなく実際の verifier が reject することを確認する)", () => {
  function evaluatedFixture(): { evaluation: ShadowEvaluation; receipt: CandidateReceipt } {
    const { manifest, bundle, verification, reviewFinding } = fullPool();
    const input = baseInput(
      [manifest, bundle, verification, reviewFinding],
      bundle.digest,
      manifest.digest,
    );
    const evaluation = evaluate(input);
    if (!evaluation.candidate_receipt) throw new Error("fixture bug: expected a candidate_receipt");
    return { evaluation, receipt: evaluation.candidate_receipt };
  }

  it("dropping one predicate leaves the receipt schema-valid (raw JSON Schema has no completeness rule) -- and even after recomputing semantic_digest to hide the drop, the REAL vendored checkReceipt still rejects it via predicate-set completeness (R21)", async () => {
    const { receipt } = evaluatedFixture();
    expect(receipt.predicates).toHaveLength(6);
    const droppedOne: CandidateReceipt = { ...receipt, predicates: receipt.predicates.slice(1) };
    // The naive "did semantic_digest change" check (this describe block's predecessor, before
    // terra review must-5) would MISS this: an attacker who also recomputes semantic_digest after
    // dropping a predicate produces an object that is both schema-valid AND digest-consistent.
    // Only a verifier that actually understands predicate-set completeness -- not a bare digest
    // comparison -- can catch it.
    const digestConsistentButIncomplete: CandidateReceipt = {
      ...droppedOne,
      semantic_digest: computeSemanticDigest(droppedOne as unknown as Record<string, unknown>),
    };
    expect(digestConsistentButIncomplete.semantic_digest).not.toBe(receipt.semantic_digest);
    const reasons = await checkReceiptAgainstVendoredVerifier(digestConsistentButIncomplete);
    expect(reasons.some((r) => r.includes("predicate_missing"))).toBe(true);
  });

  it("duplicating one predicate leaves the receipt schema-valid -- and even after recomputing semantic_digest to hide the duplicate, the REAL vendored checkReceipt still rejects it via predicate-set completeness (R21)", async () => {
    const { receipt } = evaluatedFixture();
    const firstPredicate = receipt.predicates[0];
    if (!firstPredicate) throw new Error("fixture bug: expected at least one predicate");
    const duplicated: CandidateReceipt = {
      ...receipt,
      predicates: [...receipt.predicates, firstPredicate],
    };
    const digestConsistentButDuplicated: CandidateReceipt = {
      ...duplicated,
      semantic_digest: computeSemanticDigest(duplicated as unknown as Record<string, unknown>),
    };
    expect(digestConsistentButDuplicated.semantic_digest).not.toBe(receipt.semantic_digest);
    const reasons = await checkReceiptAgainstVendoredVerifier(digestConsistentButDuplicated);
    expect(reasons.some((r) => r.includes("predicate_duplicate"))).toBe(true);
  });

  it("dropping a predicate WITHOUT recomputing semantic_digest is also caught by this evaluator's own recompute-and-compare (defense in depth -- the check this describe block had before must-5, kept alongside the stronger one above)", () => {
    const { receipt } = evaluatedFixture();
    const droppedOne: CandidateReceipt = { ...receipt, predicates: receipt.predicates.slice(1) };
    const recomputed = computeSemanticDigest(droppedOne as unknown as Record<string, unknown>);
    expect(recomputed).not.toBe(droppedOne.semantic_digest);
  });
});

describe("tamper injection: ⑥ shadow-evaluation/v0 wrapper's own self-digests / projection substituted (post-hoc output tamper, terra review must-5's verify.ts)", () => {
  it("substituting record_digest with an unrelated value still leaves the wrapper schema-valid (it's just a sha256-shaped string) but verifyRecordDigest's recompute-and-compare catches it", () => {
    const { manifest, bundle, verification, reviewFinding } = fullPool();
    const input = baseInput(
      [manifest, bundle, verification, reviewFinding],
      bundle.digest,
      manifest.digest,
    );
    const evaluation = evaluate(input);

    const tampered: ShadowEvaluation = {
      ...evaluation,
      record_digest: SHA("attacker-substituted-record-digest"),
    };
    // Schema-shape alone still passes -- record_digest's own schema rule is only a sha256: string
    // pattern (input.ts SHADOW_EVALUATION_SCHEMA_V0), which any well-formed-looking digest
    // satisfies regardless of whether it's the RIGHT one.
    expect(validateShadowEvaluation(tampered)).toEqual([]);
    expect(verifyRecordDigest(tampered)).toBe(false);
    // verifyRecordDigest on the UNTAMPERED evaluation confirms the mismatch above is specifically
    // due to the substitution, not some incidental instability in the digest function itself.
    expect(verifyRecordDigest(evaluation)).toBe(true);

    // recomputing directly still reproduces the exact original value, same underlying function
    // verifyRecordDigest wraps.
    const recomputed = computeRecordDigest(tampered as unknown as Record<string, unknown>);
    expect(recomputed).toBe(evaluation.record_digest);
  });

  it("substituting input_manifest.digest with an unrelated value still leaves the wrapper schema-valid but verifyInputManifestDigest's recompute-and-compare catches it", () => {
    const { manifest, bundle, verification, reviewFinding } = fullPool();
    const input = baseInput(
      [manifest, bundle, verification, reviewFinding],
      bundle.digest,
      manifest.digest,
    );
    const evaluation = evaluate(input);

    const tampered: ShadowEvaluation = {
      ...evaluation,
      input_manifest: {
        ...evaluation.input_manifest,
        digest: SHA("attacker-substituted-manifest-digest"),
      },
    };
    expect(validateShadowEvaluation(tampered)).toEqual([]);
    expect(verifyInputManifestDigest(tampered)).toBe(false);
    expect(verifyInputManifestDigest(evaluation)).toBe(true);
  });

  it("editing candidate_receipt.predicates without a matching edit to predicate_observations still leaves the wrapper schema-valid but verifyPredicateProjection's recompute-and-compare catches it", () => {
    const { manifest, bundle, verification, reviewFinding } = fullPool();
    const input = baseInput(
      [manifest, bundle, verification, reviewFinding],
      bundle.digest,
      manifest.digest,
    );
    const evaluation = evaluate(input);
    if (!evaluation.candidate_receipt) throw new Error("fixture bug: expected a candidate_receipt");

    const firstPredicate = evaluation.candidate_receipt.predicates[0];
    if (!firstPredicate) throw new Error("fixture bug: expected at least one predicate");
    const tampered: ShadowEvaluation = {
      ...evaluation,
      candidate_receipt: {
        ...evaluation.candidate_receipt,
        predicates: [...evaluation.candidate_receipt.predicates, firstPredicate],
      },
    };
    expect(validateShadowEvaluation(tampered)).toEqual([]);
    expect(verifyPredicateProjection(tampered)).toBe(false);
    expect(verifyPredicateProjection(evaluation)).toBe(true);
  });
});
