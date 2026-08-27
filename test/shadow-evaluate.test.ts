// Unit tests for src/shadow/evaluate.ts: one satisfied/contradicted/unknown pass per predicate
// where the predicate's own design allows it (see evaluate.ts's per-predicate doc comments for
// which branches are reachable at all -- e.g. artifact_identity has no reachable "unknown" once
// the wrapper-level existence gates have passed), plus the explicit scenario matrix chunk 2's
// task asked for (lane_ref_omitted / referent_unresolved / not_yet_recorded / unknown_structural)
// and a full-fidelity check of a generated candidate_receipt against the REAL vendored
// promotion-receipt/v0 schema (not input.ts's hand-written mirror -- implement-notes.md "非自明
// な判断 2", the gap this chunk closes).
//
// Since terra review must-1/-2 (2026-08-27), every release_evidence_bundle/release_event/
// review_finding_record/verification_record fixture below must be genuinely contract-valid
// content (src/shadow/contracts.ts now validates it in full before any predicate runs), and
// review_admissibility/rollback_target_valid's "satisfied" branches require the new
// subject.review_finding_digest / subject.rollback_previous_bundle_digest pointer chains
// (must-2) to actually resolve -- see test/helpers.ts's validBundleContent/validEventContent/
// validReviewFindingContent/validVerificationRecordContent builders.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createValidator } from "#vendor/schema-validator.mjs";
import {
  SHADOW_EVALUATOR_VERSION,
  evaluate,
  resolvePolicySnapshot,
} from "../src/shadow/evaluate.js";
import type { CandidateReceipt, ExactRecord, ShadowEvaluationInput } from "../src/shadow/input.js";
import { resolveRecordPool } from "../src/shadow/resolver.js";
import { recordContentDigest } from "../src/shadow/serialize.js";
import {
  validBundleContent,
  validEventContent,
  validReviewFindingContent,
  validVerificationRecordContent,
} from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMOTION_RECEIPT_SCHEMA_DIR = path.join(
  REPO_ROOT,
  "vendor",
  "playbook-contracts",
  "promotion-receipt",
  "v0",
);

function verifyCandidateReceiptFullFidelity(receipt: CandidateReceipt): string[] {
  const { validate } = createValidator(PROMOTION_RECEIPT_SCHEMA_DIR);
  return validate("promotion-receipt.schema.json", receipt);
}

const HEX_DIGITS = "0123456789abcdef";
const SHA = (label: string) => `sha256:${(HEX_DIGITS[label.charCodeAt(0) % 16] ?? "0").repeat(64)}`;

function record(kind: ExactRecord["kind"], content: unknown, observed_at?: string): ExactRecord {
  const digest = recordContentDigest(content);
  return observed_at ? { kind, digest, content, observed_at } : { kind, digest, content };
}

const EVALUATION_CUT = "2026-08-23T00:00:00Z";

const VERIFICATION_CONTENT = validVerificationRecordContent("v-1");
const VERIFICATION_DIGEST = recordContentDigest(VERIFICATION_CONTENT);

const RELEASE_ID = "spec-lane@0.7.0";

function bundleContent(
  opts: Parameters<typeof validBundleContent>[0] = {},
): Record<string, unknown> {
  return validBundleContent({
    release_id: RELEASE_ID,
    lane_ref: { verification_digest: VERIFICATION_DIGEST },
    review: { decision: "approved" },
    rollback_previous_release_id: null,
    ...opts,
  });
}

function baseInput(overrides: Partial<ShadowEvaluationInput> = {}): ShadowEvaluationInput {
  return {
    schema_version: "shadow-evaluation-input/v0",
    evaluation_cut: EVALUATION_CUT,
    // round C: an honest "no policy snapshot for this evaluation" declaration, not a
    // placeholder digest that happens not to resolve (see the "policy_snapshot pointer chain"
    // describe block below for tests that DO exercise a resolving/unresolving non-null digest).
    policy: {
      digest: null,
      absent_reason: { code: "policy_snapshot_absent", note: "test fixture default" },
      effective_risk: "medium",
    },
    contract_pin: { playbook_commit: "f9f0c127588f60fd299a02859c9f70f0b81a9dcc" },
    subject: {
      bundle_digest: recordContentDigest(bundleContent()),
      selection_manifest_digest: SHA("m"),
      target: "production",
    },
    records: [],
    ...overrides,
  };
}

function manifestRecord(): ExactRecord {
  return record("selection_manifest", { manifest_id: "sm-1" });
}

function bundleRecord(opts: Parameters<typeof validBundleContent>[0] = {}): ExactRecord {
  return record("release_evidence_bundle", bundleContent(opts));
}

function verificationRecord(): ExactRecord {
  return record("verification_record", VERIFICATION_CONTENT);
}

function reviewFindingRecord(recordId = "rf-1"): ExactRecord {
  return record(
    "review_finding_record",
    validReviewFindingContent({ record_id: recordId, recorded_at: EVALUATION_CUT }),
    EVALUATION_CUT,
  );
}

/** A fully resolvable input: manifest present, bundle present (lane-backed, review approved, no
 * rollback target), verification record resolved via lane_ref.verification_digest, a
 * review-finding record resolved via subject.review_finding_digest, and a LEGAL release-event
 * lifecycle (prepared -> deployed|preview -> verified|preview, terra review round C: a lone
 * verified/preview event with no preceding prepared/deployed folds illegally through the D5
 * transition graph and must never be trusted as satisfied evidence -- see
 * `foldAttemptEvents`/evaluate.ts) so preview_verified resolves to a LEGITIMATELY earned
 * satisfied. */
function fullyResolvedInput(): ShadowEvaluationInput {
  const manifest = manifestRecord();
  const bundle = bundleRecord();
  const verification = verificationRecord();
  const reviewFinding = reviewFindingRecord();
  const preparedEvent = record(
    "release_event",
    validEventContent({
      release_id: RELEASE_ID,
      kind: "prepared",
      environment: null,
      bundle_digest: bundle.digest,
      occurred_at: "2026-08-21T00:00:00Z",
    }),
    "2026-08-21T00:00:00Z",
  );
  const previewDeployedEvent = record(
    "release_event",
    validEventContent({
      release_id: RELEASE_ID,
      kind: "deployed",
      environment: "preview",
      bundle_digest: bundle.digest,
      occurred_at: "2026-08-22T00:00:00Z",
    }),
    "2026-08-22T00:00:00Z",
  );
  const previewVerifiedEvent = record(
    "release_event",
    validEventContent({
      release_id: RELEASE_ID,
      kind: "verified",
      environment: "preview",
      bundle_digest: bundle.digest,
      occurred_at: EVALUATION_CUT,
    }),
    EVALUATION_CUT,
  );
  return baseInput({
    subject: {
      bundle_digest: bundle.digest,
      selection_manifest_digest: manifest.digest,
      target: "production",
      review_finding_digest: reviewFinding.digest,
      rollback_previous_bundle_digest: null,
    },
    records: [
      manifest,
      bundle,
      verification,
      reviewFinding,
      preparedEvent,
      previewDeployedEvent,
      previewVerifiedEvent,
    ],
  });
}

describe("evaluate: wrapper-level gates", () => {
  it("selection_manifest absent from the pool -> evaluation_status=unknown, reason=unknown_structural, no receipt", () => {
    const bundle = bundleRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: SHA("missing"),
        target: "production",
      },
      records: [bundle],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("unknown");
    expect(result.unknown_reasons).toEqual([
      expect.objectContaining({ code: "unknown_structural" }),
    ]);
    expect(result.candidate_receipt).toBeNull();
    expect(result.predicate_observations).toEqual([]);
    expect(result.input_errors).toEqual([]);
  });

  it("selection_manifest_digest resolves but to the wrong kind -> evaluation_status=unknown, reason=unknown_structural, no receipt (terra review must-2)", () => {
    const bundle = bundleRecord();
    const wrongKindManifest = record("other", { not_a_manifest: true });
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: wrongKindManifest.digest,
        target: "production",
      },
      records: [bundle, wrongKindManifest],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("unknown");
    expect(result.unknown_reasons).toEqual([
      expect.objectContaining({ code: "unknown_structural" }),
    ]);
    expect(result.candidate_receipt).toBeNull();
  });

  it("bundle_digest absent from the pool -> evaluation_status=unknown, reason=referent_unresolved, no receipt", () => {
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: SHA("missing"),
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("unknown");
    expect(result.unknown_reasons).toEqual([
      expect.objectContaining({ code: "referent_unresolved" }),
    ]);
    expect(result.candidate_receipt).toBeNull();
    expect(result.predicate_observations).toEqual([]);
  });

  it("a tampered exact record (digest mismatch) -> evaluation_status=invalid_input, input_errors populated, no receipt", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const tampered: ExactRecord = {
      ...bundle,
      content: { ...bundleContent(), release_id: "tampered" },
    };
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, tampered],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([expect.objectContaining({ code: "digest_mismatch" })]);
    expect(result.candidate_receipt).toBeNull();
    expect(result.predicate_observations).toEqual([]);
    expect(result.unknown_reasons).toEqual([]);
  });
});

describe("evaluate: full resolution produces a schema-valid candidate_receipt", () => {
  it("produces evaluation_status=evaluated with all 6 predicates in closed order", () => {
    const result = evaluate(fullyResolvedInput());
    expect(result.evaluation_status).toBe("evaluated");
    expect(result.candidate_receipt).not.toBeNull();
    const ids = result.predicate_observations.map((o) => o.predicate_id);
    expect(ids).toEqual([
      "artifact_identity",
      "review_admissibility",
      "verification_coverage",
      "preview_verified",
      "rollback_target_valid",
      "privilege_boundary",
    ]);
  });

  it("verdict is abstained (privilege_boundary is always an applicable unknown until a static scan exists)", () => {
    const result = evaluate(fullyResolvedInput());
    expect(result.candidate_receipt?.verdict).toBe("abstained");
  });

  it("artifact_identity / review_admissibility / verification_coverage / preview_verified are all satisfied; rollback_target_valid is not_applicable", () => {
    const result = evaluate(fullyResolvedInput());
    const byId = new Map(result.predicate_observations.map((o) => [o.predicate_id, o]));
    expect(byId.get("artifact_identity")).toMatchObject({
      status: "satisfied",
      applicability: "applicable",
    });
    expect(byId.get("review_admissibility")).toMatchObject({
      status: "satisfied",
      applicability: "applicable",
    });
    expect(byId.get("verification_coverage")).toMatchObject({
      status: "satisfied",
      applicability: "applicable",
    });
    expect(byId.get("preview_verified")).toMatchObject({
      status: "satisfied",
      applicability: "applicable",
    });
    expect(byId.get("rollback_target_valid")).toMatchObject({
      applicability: "not_applicable",
      status: "unknown",
    });
  });

  it("evaluator.version and evaluator.playbook_contract_commit are populated from the constant and input.contract_pin", () => {
    const result = evaluate(fullyResolvedInput());
    expect(result.evaluator.version).toBe(SHADOW_EVALUATOR_VERSION);
    expect(result.evaluator.playbook_contract_commit).toBe(
      "f9f0c127588f60fd299a02859c9f70f0b81a9dcc",
    );
  });

  it("the generated candidate_receipt passes full-fidelity verification against the vendored promotion-receipt/v0 schema", () => {
    const result = evaluate(fullyResolvedInput());
    expect(result.candidate_receipt).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    expect(verifyCandidateReceiptFullFidelity(result.candidate_receipt!)).toEqual([]);
  });

  it("evaluated_at equals evaluation_cut (never an ambient clock)", () => {
    const result = evaluate(fullyResolvedInput());
    expect(result.candidate_receipt?.evaluated_at).toBe(EVALUATION_CUT);
  });
});

describe("evaluate: artifact_identity", () => {
  it("contradicted when the record resolved at subject.bundle_digest has the wrong kind", () => {
    const manifest = manifestRecord();
    const wrongKind = reviewFindingRecord("rf-mismatch");
    const input = baseInput({
      subject: {
        bundle_digest: wrongKind.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, wrongKind],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "artifact_identity",
    );
    expect(observation).toMatchObject({ status: "contradicted", applicability: "applicable" });
  });
});

describe("evaluate: review_admissibility", () => {
  it('contradicted when bundle.review.decision is "commented" (no pointer needed -- a comment is inadmissible regardless)', () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord({ review: { decision: "commented" } });
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "review_admissibility",
    );
    expect(observation).toMatchObject({ status: "contradicted", applicability: "applicable" });
  });

  it("unknown/referent_unresolved when bundle.review is non-null but no review_finding_digest pointer was given (terra review must-2)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord({ review: { decision: "self_merged" } });
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "review_admissibility",
    );
    expect(observation).toMatchObject({
      status: "unknown",
      applicability: "applicable",
      reason: expect.objectContaining({ code: "referent_unresolved" }),
    });
  });

  it("satisfied when bundle.review.decision is self_merged AND the review-finding pointer resolves (mirrors gates.ts checkProductionGate policy, grounded via must-2's pointer chain)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord({ review: { decision: "self_merged" } });
    const reviewFinding = reviewFindingRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
        review_finding_digest: reviewFinding.digest,
      },
      records: [manifest, bundle, reviewFinding],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "review_admissibility",
    );
    expect(observation).toMatchObject({ status: "satisfied", applicability: "applicable" });
  });

  it("unknown (unknown_structural) when bundle.review is null", () => {
    const bundle = bundleRecord({ review: null });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "review_admissibility",
    );
    expect(observation).toMatchObject({
      status: "unknown",
      applicability: "applicable",
      reason: {
        code: "unknown_structural",
        params: expect.objectContaining({ review_omitted_code: "other" }),
      },
    });
  });
});

describe("evaluate: verification_coverage", () => {
  it("non-lane release (lane_ref=null) -> unknown/lane_ref_omitted with the bundle's own omission code", () => {
    const bundle = bundleRecord({
      lane_ref: null,
      lane_ref_omitted_code: "legacy_release_predates_contract",
    });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "verification_coverage",
    );
    expect(observation).toMatchObject({
      status: "unknown",
      applicability: "applicable",
      reason: {
        code: "lane_ref_omitted",
        params: { omission_code: "legacy_release_predates_contract" },
      },
    });
  });

  it("verification_digest pointer present but no matching record -> unknown/referent_unresolved", () => {
    const bundle = bundleRecord({ lane_ref: { verification_digest: SHA("dangling") } });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "verification_coverage",
    );
    expect(observation).toMatchObject({
      status: "unknown",
      applicability: "applicable",
      reason: expect.objectContaining({ code: "referent_unresolved" }),
    });
  });

  it("satisfied when the verification_digest resolves to a verification_record", () => {
    const result = evaluate(fullyResolvedInput());
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "verification_coverage",
    );
    expect(observation).toMatchObject({
      status: "satisfied",
      applicability: "applicable",
      evidence_refs: [{ kind: "release_evidence", ref: RELEASE_ID, digest: expect.any(String) }],
    });
  });

  it("contradicted when the resolved record has the wrong kind", () => {
    const wrongKindAtVerification = reviewFindingRecord("rf-wrong-kind-at-verification-digest");
    const bundle = bundleRecord({
      lane_ref: { verification_digest: wrongKindAtVerification.digest },
    });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, wrongKindAtVerification],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "verification_coverage",
    );
    expect(observation).toMatchObject({ status: "contradicted", applicability: "applicable" });
  });
});

describe("evaluate: preview_verified", () => {
  it("not_applicable when subject.target is preview", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "preview",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "preview_verified",
    );
    expect(observation).toMatchObject({ applicability: "not_applicable", status: "unknown" });
  });

  it("not_applicable when a deployed/production event recorded preview_skipped=true", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const skipEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "deployed",
        environment: "production",
        bundle_digest: bundle.digest,
        occurred_at: EVALUATION_CUT,
        preview_skipped: true,
      }),
      EVALUATION_CUT,
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, skipEvent],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "preview_verified",
    );
    expect(observation).toMatchObject({ applicability: "not_applicable", status: "unknown" });
  });

  it("contradicted when a failed/preview event was recorded", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const failedEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "failed",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: EVALUATION_CUT,
        failure_phase: "verification",
        reason: "preview verification failed",
      }),
      EVALUATION_CUT,
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, failedEvent],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "preview_verified",
    );
    expect(observation).toMatchObject({ applicability: "applicable", status: "contradicted" });
  });

  it("unknown/not_yet_recorded when the only verified/preview event was observed AFTER evaluation_cut (hindsight leakage guard)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const futureOccurredAt = "2026-08-24T00:00:00Z"; // after EVALUATION_CUT
    const futureVerified = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "verified",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: futureOccurredAt,
      }),
      futureOccurredAt,
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, futureVerified],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "preview_verified",
    );
    expect(observation).toMatchObject({
      applicability: "applicable",
      status: "unknown",
      reason: expect.objectContaining({ code: "not_yet_recorded" }),
    });
  });

  it("satisfied when a verified/preview event was recorded at or before evaluation_cut", () => {
    const result = evaluate(fullyResolvedInput());
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "preview_verified",
    );
    expect(observation).toMatchObject({ applicability: "applicable", status: "satisfied" });
  });
});

describe("evaluate: rollback_target_valid", () => {
  it("not_applicable when rollback.previous_release_id is null", () => {
    const result = evaluate(fullyResolvedInput());
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "rollback_target_valid",
    );
    expect(observation).toMatchObject({ applicability: "not_applicable", status: "unknown" });
  });

  it("a self-referential rollback target is now an INVALID bundle, not a contradicted predicate -- the full bundle-content contract (contracts.ts, reusing core/bundle.ts's bundleSemanticChecks) rejects rollback_to_self before any predicate runs", () => {
    const bundle = bundleRecord({ rollback_previous_release_id: RELEASE_ID });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "release_evidence_bundle",
          errors: expect.arrayContaining([expect.stringContaining("rollback_to_self")]),
        }),
      }),
    ]);
    expect(result.candidate_receipt).toBeNull();
  });

  it("evalRollbackTargetValid's own self-reference guard still catches a self-referencing rollback when the resolved record's kind bypasses bundle-content validation entirely (defense in depth for a non-contracted kind at bundle_digest)", () => {
    const selfReferencing = record("other", {
      release_id: RELEASE_ID,
      lane_ref: null,
      review: null,
      rollback: { previous_release_id: RELEASE_ID },
    });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: selfReferencing.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, selfReferencing],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "rollback_target_valid",
    );
    expect(observation).toMatchObject({ applicability: "applicable", status: "contradicted" });
  });

  it("satisfied when the previous bundle resolves and a deployed/production event is bound to ITS OWN digest via a LEGAL release lifecycle (terra review must-2 / round C: a lone deployed|production event with no preceding prepared is an illegal_transition, never trusted as satisfied evidence)", () => {
    const previousReleaseId = "spec-lane@0.6.0";
    const bundle = bundleRecord({ rollback_previous_release_id: previousReleaseId });
    const previousBundle = record(
      "release_evidence_bundle",
      validBundleContent({ release_id: previousReleaseId }),
    );
    const manifest = manifestRecord();
    const priorPrepared = record(
      "release_event",
      validEventContent({
        release_id: previousReleaseId,
        kind: "prepared",
        environment: null,
        bundle_digest: previousBundle.digest,
        occurred_at: "2026-08-20T00:00:00Z",
      }),
      "2026-08-20T00:00:00Z",
    );
    const priorProd = record(
      "release_event",
      validEventContent({
        release_id: previousReleaseId,
        kind: "deployed",
        environment: "production",
        bundle_digest: previousBundle.digest,
        occurred_at: EVALUATION_CUT,
        // A direct prepared -> production jump requires preview_skipped=true (fold.ts's D5
        // graph) -- this previous release has no lane_ref (validBundleContent's default), so it
        // never had a preview tier at all.
        preview_skipped: true,
      }),
      EVALUATION_CUT,
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
        rollback_previous_bundle_digest: previousBundle.digest,
      },
      records: [manifest, bundle, previousBundle, priorPrepared, priorProd],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "rollback_target_valid",
    );
    expect(observation).toMatchObject({ applicability: "applicable", status: "satisfied" });
  });

  it("unknown/referent_unresolved when no rollback_previous_bundle_digest pointer was given", () => {
    const bundle = bundleRecord({ rollback_previous_release_id: "spec-lane@0.6.0" });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "rollback_target_valid",
    );
    expect(observation).toMatchObject({
      applicability: "applicable",
      status: "unknown",
      reason: expect.objectContaining({ code: "referent_unresolved" }),
    });
  });

  it("unknown/referent_unresolved when the previous bundle resolves but no deployed/production event is bound to ITS digest", () => {
    const previousReleaseId = "spec-lane@0.6.0";
    const bundle = bundleRecord({ rollback_previous_release_id: previousReleaseId });
    const previousBundle = record(
      "release_evidence_bundle",
      validBundleContent({ release_id: previousReleaseId }),
    );
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
        rollback_previous_bundle_digest: previousBundle.digest,
      },
      records: [manifest, bundle, previousBundle],
    });
    const result = evaluate(input);
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "rollback_target_valid",
    );
    expect(observation).toMatchObject({
      applicability: "applicable",
      status: "unknown",
      reason: expect.objectContaining({ code: "referent_unresolved" }),
    });
  });
});

describe("evaluate: privilege_boundary", () => {
  it("is always applicable/unknown/unknown_structural, with the necessary-not-sufficient caveat note attached", () => {
    const result = evaluate(fullyResolvedInput());
    const observation = result.predicate_observations.find(
      (o) => o.predicate_id === "privilege_boundary",
    );
    expect(observation).toMatchObject({
      applicability: "applicable",
      status: "unknown",
      reason: expect.objectContaining({ code: "unknown_structural" }),
    });
    expect(observation?.notes).toMatch(/necessary condition, not a sufficient one/);
  });
});

describe("evaluate: determinism", () => {
  it("is stable across two independent calls with a deep-cloned input (no ambient clock/random state)", () => {
    const input = fullyResolvedInput();
    const cloned = JSON.parse(JSON.stringify(input)) as ShadowEvaluationInput;
    const a = evaluate(input);
    const b = evaluate(cloned);
    expect(a).toEqual(b);
    expect(a.record_digest).toBe(b.record_digest);
  });

  it("input.records array order does not affect input_manifest.digest or record_digest", () => {
    const input = fullyResolvedInput();
    const reversed = { ...input, records: [...input.records].reverse() };
    const a = evaluate(input);
    const b = evaluate(reversed);
    expect(a.input_manifest.digest).toBe(b.input_manifest.digest);
    expect(a.record_digest).toBe(b.record_digest);
  });
});

describe("evaluate: must-1 regression (terra review 2026-08-27) -- terra's own reproduction no longer produces a false satisfied", () => {
  it('a bundle missing required contract fields, decision:"definitely-not-a-contract-value", an empty verification record, and an incomplete release_event -> evaluation_status=invalid_input (never artifact_identity/review_admissibility/verification_coverage/preview_verified=satisfied)', () => {
    // terra's exact repro, transcribed: shallow parseBundleLike-shaped content that used to be
    // enough to reach "satisfied" on four predicates, before contracts.ts's full schema+semantic
    // validation layer existed. Missing: schema_version, source, artifacts, build,
    // known_deviations, integrity (bundle); schema_version, verification_id (verification
    // record); schema_version, event_id, occurred_at, actor (release_event) -- and an out-of-enum
    // review decision the full bundle schema, but not parseBundleLike, would ever reject.
    const brokenVerification = record("verification_record", {});
    const brokenBundleContent = {
      release_id: "spec-lane@0.7.0",
      lane_ref: { verification_digest: brokenVerification.digest },
      review: { decision: "definitely-not-a-contract-value" },
      rollback: { previous_release_id: null },
    };
    const brokenBundle = record("release_evidence_bundle", brokenBundleContent);
    const brokenEvent = record("release_event", {
      release_id: "spec-lane@0.7.0",
      kind: "verified",
      environment: "preview",
      bundle_digest: brokenBundle.digest,
    });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: brokenBundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, brokenBundle, brokenVerification, brokenEvent],
    });

    const result = evaluate(input);

    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.candidate_receipt).toBeNull();
    expect(result.predicate_observations).toEqual([]);
    const invalidKinds = result.input_errors
      .filter((e) => e.code === "record_invalid")
      .map((e) => e.params.kind);
    expect(invalidKinds).toEqual(
      expect.arrayContaining(["release_evidence_bundle", "verification_record", "release_event"]),
    );
  });

  it("an unsupported record schema_version -> unsupported_record_version, never treated as a same-version record_invalid", () => {
    const futureVerification = record("verification_record", {
      schema_version: "verification-record/v99",
      verification_id: "v-future",
    });
    const bundle = bundleRecord({ lane_ref: { verification_digest: futureVerification.digest } });
    const manifest = manifestRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, futureVerification],
    });

    const result = evaluate(input);

    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "unsupported_record_version",
        params: expect.objectContaining({
          kind: "verification_record",
          declared_schema_version: "verification-record/v99",
        }),
      }),
    ]);
  });
});

describe("evaluate: must-1 round C regression (terra re-review 2026-08-27) -- review-findings/v1 semantic MUST the schema alone cannot express", () => {
  function baseFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      finding_id: "f-1",
      category: "correctness",
      severity: "high",
      claim: "example claim",
      locations: [{ path: "src/x.ts", start_line: 1, end_line: 2 }],
      suggested_fix: null,
      evidence_gate: {
        oracle_kind: "evigate",
        oracle_ref: "ref-1",
        predicate: { code: "p", params: {} },
        required_verdict: "proven",
      },
      ...overrides,
    };
  }

  function findingRecordContent(
    findings: Record<string, unknown>[],
    contentOverrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schema_version: "review-findings/v1",
      record_id: "rf-must1-round-c",
      recorded_at: EVALUATION_CUT,
      supersedes_record_id: null,
      subject: { repository_ref: "shiki-yusuke/spec-lane", digest: SHA("s") },
      scan_scope: {
        paths: ["**/*"],
        commit_range: { base: "b".repeat(40), head: "c".repeat(40) },
        lenses: ["correctness"],
      },
      assessor: {
        kind: "deterministic_tool",
        model_cohort: null,
        independence: { code: "different_provider", params: {} },
      },
      outcome: "findings_observed",
      abstention: null,
      findings,
      ...contentOverrides,
    };
  }

  function invalidInputFor(reviewFindingContent: Record<string, unknown>) {
    const reviewFinding = record("review_finding_record", reviewFindingContent, EVALUATION_CUT);
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, reviewFinding],
    });
    return evaluate(input);
  }

  it("a duplicate finding_id within one record -> record_invalid (reference reject: reject-duplicate-finding-id.json)", () => {
    const result = invalidInputFor(
      findingRecordContent([
        baseFinding({ finding_id: "dup" }),
        baseFinding({ finding_id: "dup" }),
      ]),
    );
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "review_finding_record",
          errors: expect.arrayContaining([expect.stringContaining("duplicate_finding_id")]),
        }),
      }),
    ]);
  });

  it("a location with only one of start_line/end_line recorded -> record_invalid (reference reject: reject at location_line_partial)", () => {
    const result = invalidInputFor(
      findingRecordContent([
        baseFinding({ locations: [{ path: "src/x.ts", start_line: 1, end_line: null }] }),
      ]),
    );
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "review_finding_record",
          errors: expect.arrayContaining([expect.stringContaining("location_line_partial")]),
        }),
      }),
    ]);
  });

  it("a location with end_line < start_line -> record_invalid (reference reject: location_line_order)", () => {
    const result = invalidInputFor(
      findingRecordContent([
        baseFinding({ locations: [{ path: "src/x.ts", start_line: 5, end_line: 1 }] }),
      ]),
    );
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "review_finding_record",
          errors: expect.arrayContaining([expect.stringContaining("location_line_order")]),
        }),
      }),
    ]);
  });

  it("a numeric confidence field smuggled into an open params bag -> record_invalid (reference reject: reject-numeric-confidence-in-params.json)", () => {
    const result = invalidInputFor(
      findingRecordContent([
        baseFinding({
          evidence_gate: {
            oracle_kind: "evigate",
            oracle_ref: "ref-1",
            predicate: { code: "p", params: { confidence: 0.9 } },
            required_verdict: "proven",
          },
        }),
      ]),
    );
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "review_finding_record",
          errors: expect.arrayContaining([
            expect.stringContaining("numeric_confidence_forbidden_field"),
          ]),
        }),
      }),
    ]);
  });

  it("a personal-dimension key smuggled into an open params bag -> record_invalid (reference reject: reject-personal-dimension-in-params.json)", () => {
    const result = invalidInputFor(
      findingRecordContent([], {
        assessor: {
          kind: "deterministic_tool",
          model_cohort: null,
          independence: { code: "different_provider", params: { author: "someone" } },
        },
        outcome: "none_observed_in_recorded_scope",
      }),
    );
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "review_finding_record",
          errors: expect.arrayContaining([
            expect.stringContaining("personal_dimension_forbidden_key"),
          ]),
        }),
      }),
    ]);
  });

  it("a genuinely clean review-finding record (no violations) is not rejected by any of the new semantic MUST checks (no over-reject)", () => {
    const result = invalidInputFor(findingRecordContent([baseFinding()]));
    expect(result.evaluation_status).toBe("evaluated");
    expect(result.input_errors).toEqual([]);
  });
});

describe("evaluate: must-3 regression (terra review 2026-08-27) -- evaluation_cut can no longer be bypassed", () => {
  it('an unreal evaluation_cut (regex-shaped but not a real calendar date) -> evaluation_status=invalid_input, never silently treated as "nothing is future"', () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const input = baseInput({
      evaluation_cut: "2026-99-99T00:00:00Z",
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({ field: "evaluation_cut" }),
      }),
    ]);
  });

  it("omitting observed_at on a release_event no longer bypasses the cut -- it is now record_invalid (observed_at is mandatory for a time-bearing kind), not a silent pass", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const futureEventNoObservedAt = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "verified",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: "2099-01-01T00:00:00Z",
      }),
      // no observed_at given -- this is exactly terra's repro ("observed_at を省けば...
      // satisfied になった")
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, futureEventNoObservedAt],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({ kind: "release_event" }),
      }),
    ]);
  });

  it("observed_at present but disagreeing with content.occurred_at -> record_invalid (a lie about when this record became visible, not a legitimate future exclusion)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const lyingEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "verified",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: "2099-01-01T00:00:00Z", // claims a future occurrence...
      }),
      EVALUATION_CUT, // ...but declares observed_at at/before cut, to sneak past hindsight guard
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, lyingEvent],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({ kind: "release_event" }),
      }),
    ]);
  });

  it("a genuinely future record whose content is tampered is excluded as future, never turned into digest_mismatch (cut-exclusion happens before content digest is ever recomputed)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const futureOccurredAt = "2026-08-24T00:00:00Z"; // after EVALUATION_CUT
    const originalContent = validEventContent({
      release_id: RELEASE_ID,
      kind: "verified",
      environment: "preview",
      bundle_digest: bundle.digest,
      occurred_at: futureOccurredAt,
    });
    const staleDigest = recordContentDigest(originalContent);
    const tamperedFutureEvent: ExactRecord = {
      kind: "release_event",
      digest: staleDigest,
      content: { ...originalContent, notes: "attacker edited this after computing the digest" },
      observed_at: futureOccurredAt,
    };
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, tamperedFutureEvent],
    });
    const result = evaluate(input);
    // The whole point: this must NOT be invalid_input. A future record's tampered content must
    // never contaminate an evaluation that was never allowed to look at it in the first place.
    expect(result.evaluation_status).toBe("evaluated");
    expect(result.input_errors).toEqual([]);
  });
});

describe("evaluate: must-4 regression (terra review 2026-08-27) -- duplicate-digest kind collision no longer flips the result by array order", () => {
  it("a release_evidence_bundle-kind and a review_finding_record-kind record sharing one content digest -> record_invalid regardless of array order (previously: last-write-wins Map flip)", () => {
    // Content that parses as BOTH a minimal review-findings/v1 record AND happens to collide on
    // digest with itself declared under a different kind -- terra's repro used two envelopes
    // wrapping the SAME content under different `kind` labels (digest is a pure content hash, so
    // "same content, different kind" is exactly the shape that could previously flip
    // artifact_identity between contradicted and satisfied depending on Map insertion order).
    const sharedContent = validReviewFindingContent({
      record_id: "rf-collision",
      recorded_at: EVALUATION_CUT,
    });
    const sharedDigest = recordContentDigest(sharedContent);
    const asReviewFinding: ExactRecord = {
      kind: "review_finding_record",
      digest: sharedDigest,
      content: sharedContent,
      observed_at: EVALUATION_CUT,
    };
    const asBundle: ExactRecord = {
      kind: "release_evidence_bundle",
      digest: sharedDigest,
      content: sharedContent,
    };
    const manifest = manifestRecord();

    const forward = evaluate(
      baseInput({
        subject: {
          bundle_digest: sharedDigest,
          selection_manifest_digest: manifest.digest,
          target: "production",
        },
        records: [manifest, asReviewFinding, asBundle],
      }),
    );
    const reversed = evaluate(
      baseInput({
        subject: {
          bundle_digest: sharedDigest,
          selection_manifest_digest: manifest.digest,
          target: "production",
        },
        records: [manifest, asBundle, asReviewFinding],
      }),
    );

    for (const result of [forward, reversed]) {
      expect(result.evaluation_status).toBe("invalid_input");
      expect(result.input_errors).toEqual([
        expect.objectContaining({
          code: "record_invalid",
          params: expect.objectContaining({ digest: sharedDigest }),
        }),
      ]);
    }
    expect(forward.input_errors).toEqual(reversed.input_errors);
  });

  it("two envelopes for the same digest and kind but disagreeing observed_at -> record_invalid regardless of array order", () => {
    const content = { manifest_id: "sm-collision" };
    const digest = recordContentDigest(content);
    const asPast: ExactRecord = {
      kind: "policy_snapshot",
      digest,
      content,
      observed_at: "2026-08-01T00:00:00Z",
    };
    const asLaterButStillPastCut: ExactRecord = {
      kind: "policy_snapshot",
      digest,
      content,
      observed_at: "2026-08-02T00:00:00Z",
    };
    const manifest = manifestRecord();
    const bundle = bundleRecord();

    const forward = evaluate(
      baseInput({
        subject: {
          bundle_digest: bundle.digest,
          selection_manifest_digest: manifest.digest,
          target: "production",
        },
        records: [manifest, bundle, asPast, asLaterButStillPastCut],
      }),
    );
    const reversed = evaluate(
      baseInput({
        subject: {
          bundle_digest: bundle.digest,
          selection_manifest_digest: manifest.digest,
          target: "production",
        },
        records: [manifest, bundle, asLaterButStillPastCut, asPast],
      }),
    );

    for (const result of [forward, reversed]) {
      expect(result.evaluation_status).toBe("invalid_input");
      expect(result.input_errors).toEqual([
        expect.objectContaining({
          code: "record_invalid",
          params: expect.objectContaining({ digest }),
        }),
      ]);
    }
    expect(forward.input_errors).toEqual(reversed.input_errors);
  });

  it("round C: two INDEPENDENT invalid records (unrelated kinds/digests, each its own record_invalid) sort deterministically -- reversing their array order does not change input_errors order, record_digest, or output bytes", () => {
    // Two genuinely unrelated invalid records -- not a digest collision like the tests above --
    // so the only thing that could make their order in `input_errors` vary is resolver.ts
    // accumulating errors in array-arrival order (terra review round C: "独立した invalid
    // record 2件の順序反転で出力 bytes と record_digest が変化しました").
    // Distinct content (never `{}` for both -- two envelopes wrapping the SAME empty content
    // would collide on digest and be caught by the must-4 duplicate-digest path instead of
    // producing two independent errors).
    const brokenEvent = record("release_event", { broken: "event" });
    const brokenVerification = record("verification_record", { broken: "verification" });
    const manifest = manifestRecord();
    const bundle = bundleRecord();

    const forward = evaluate(
      baseInput({
        subject: {
          bundle_digest: bundle.digest,
          selection_manifest_digest: manifest.digest,
          target: "production",
        },
        records: [manifest, bundle, brokenEvent, brokenVerification],
      }),
    );
    const reversed = evaluate(
      baseInput({
        subject: {
          bundle_digest: bundle.digest,
          selection_manifest_digest: manifest.digest,
          target: "production",
        },
        records: [manifest, bundle, brokenVerification, brokenEvent],
      }),
    );

    for (const result of [forward, reversed]) {
      expect(result.evaluation_status).toBe("invalid_input");
      expect(result.input_errors).toHaveLength(2);
    }
    // Byte-for-byte identical regardless of which broken record happened to come first in the
    // input array -- the whole point of a closed (code, digest, path) sort key.
    expect(forward.input_errors).toEqual(reversed.input_errors);
    expect(forward.record_digest).toBe(reversed.record_digest);
  });
});

describe("evaluate: policy_snapshot pointer chain (round B -- closes implement-notes.md's must-2 residual note: 'policy_snapshot 側のpointer chain...スコープ外')", () => {
  const POLICY_SNAPSHOT_CONTENT = { schema_version: "policy-snapshot/v0", policy_id: "p-1" };
  const POLICY_DIGEST = recordContentDigest(POLICY_SNAPSHOT_CONTENT);

  it("resolves when a policy_snapshot record with the matching digest is in the pool", () => {
    const policyRecord = record("policy_snapshot", POLICY_SNAPSHOT_CONTENT);
    const input = baseInput({ policy: { digest: POLICY_DIGEST, effective_risk: "medium" } });
    const pool = resolveRecordPool([policyRecord], EVALUATION_CUT);
    expect(resolvePolicySnapshot(input, pool)).toEqual(policyRecord);
  });

  it("does not resolve when the digest matches a record of a DIFFERENT kind (terra review must-2's kind discipline, applied to the policy ref too -- 'kind一致だけでsatisfiedにしない')", () => {
    const wrongKind = record("other", POLICY_SNAPSHOT_CONTENT);
    const input = baseInput({ policy: { digest: POLICY_DIGEST, effective_risk: "medium" } });
    const pool = resolveRecordPool([wrongKind], EVALUATION_CUT);
    expect(resolvePolicySnapshot(input, pool)).toBeNull();
  });

  it("does not resolve, and does not error, when no policy_snapshot record is in the pool at all (today's default corpus -- '現時点のcorpusにpolicy recordが無い場合はreferent不要の任意ref')", () => {
    const input = baseInput({
      policy: { digest: SHA("no-such-policy"), effective_risk: "medium" },
    });
    const pool = resolveRecordPool([], EVALUATION_CUT);
    expect(resolvePolicySnapshot(input, pool)).toBeNull();
  });

  it("round C: a non-null policy.digest that fails to resolve -> evaluation_status=unknown, reason=referent_unresolved, no receipt (the previous round's 'silently generate a receipt despite an unresolved policy ref' path is removed)", () => {
    const unresolvableInput: ShadowEvaluationInput = {
      ...fullyResolvedInput(),
      policy: { digest: SHA("another-nonexistent-policy"), effective_risk: "medium" },
    };
    const result = evaluate(unresolvableInput);
    expect(result.evaluation_status).toBe("unknown");
    expect(result.candidate_receipt).toBeNull();
    expect(result.predicate_observations).toEqual([]);
    expect(result.unknown_reasons).toEqual([
      expect.objectContaining({
        code: "referent_unresolved",
        params: expect.objectContaining({ pointer: "policy.digest" }),
      }),
    ]);
  });

  it("round C: an explicit policy.digest=null (absent_reason=policy_snapshot_absent) never blocks or changes the evaluation (no predicate reads policy_snapshot content yet -- 捏造せず正直に: absence of data must never fabricate a different, seemingly-more-certain result) -- differs from a resolving policy ref ONLY in candidate_receipt.policy_digest and the digests derived from a receipt that embeds it", () => {
    const policyRecord = record("policy_snapshot", POLICY_SNAPSHOT_CONTENT);
    const resolvableInput: ShadowEvaluationInput = {
      ...fullyResolvedInput(),
      policy: { digest: POLICY_DIGEST, effective_risk: "medium" },
      records: [...fullyResolvedInput().records, policyRecord],
    };
    const absentInput: ShadowEvaluationInput = {
      ...fullyResolvedInput(),
      policy: {
        digest: null,
        absent_reason: { code: "policy_snapshot_absent", note: "no snapshot for this replay" },
        effective_risk: "medium",
      },
    };
    const a = evaluate(resolvableInput);
    const b = evaluate(absentInput);
    expect(a.evaluation_status).toBe("evaluated");
    expect(b.evaluation_status).toBe("evaluated");
    expect(a.predicate_observations).toEqual(b.predicate_observations);
    expect(a.candidate_receipt?.verdict).toBe(b.candidate_receipt?.verdict);
    expect(a.candidate_receipt?.policy_digest).toBe(POLICY_DIGEST);
    expect(b.candidate_receipt?.policy_digest).not.toBe(POLICY_DIGEST);
  });

  it("round C: policy.digest=null resolves to null via resolvePolicySnapshot without attempting a lookup", () => {
    const input = baseInput({
      policy: {
        digest: null,
        absent_reason: { code: "policy_snapshot_absent", note: "test fixture" },
        effective_risk: "medium",
      },
    });
    const pool = resolveRecordPool([], EVALUATION_CUT);
    expect(resolvePolicySnapshot(input, pool)).toBeNull();
  });
});

describe("evaluate: must (terra round D re-audit, 2026-08-27) -- collection-level semantic MUST that foldAttemptEvents's bundle_digest-only grouping cannot see (release_id consistency + ledger-wide event_id uniqueness, src/core/collection.ts / src/core/fold.ts)", () => {
  it("three release_event records carrying the real bundle's own digest but a forged release_id different from that bundle's -> evaluation_status=invalid_input (terra's exact repro: \"対象 bundle は spec-lane@0.7.0、3 event はすべて release_id=attacker-release\" -- reference rejects with release_id_mismatch x3, src/core/collection.ts's checkReleaseCollection; this evaluator previously called preview_verified satisfied on the strength of these same events)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const forgedReleaseId = "attacker-release";
    const preparedEvent = record(
      "release_event",
      validEventContent({
        release_id: forgedReleaseId,
        kind: "prepared",
        environment: null,
        bundle_digest: bundle.digest,
        occurred_at: "2026-08-21T00:00:00Z",
      }),
      "2026-08-21T00:00:00Z",
    );
    const previewDeployedEvent = record(
      "release_event",
      validEventContent({
        release_id: forgedReleaseId,
        kind: "deployed",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: "2026-08-22T00:00:00Z",
      }),
      "2026-08-22T00:00:00Z",
    );
    const previewVerifiedEvent = record(
      "release_event",
      validEventContent({
        release_id: forgedReleaseId,
        kind: "verified",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: EVALUATION_CUT,
      }),
      EVALUATION_CUT,
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, preparedEvent, previewDeployedEvent, previewVerifiedEvent],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.candidate_receipt).toBeNull();
    expect(result.predicate_observations).toEqual([]);
    expect(result.input_errors).toHaveLength(3);
    for (const error of result.input_errors) {
      expect(error).toMatchObject({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "release_event",
          reason: "release_id_mismatch",
          event_release_id: forgedReleaseId,
          bundle_release_id: RELEASE_ID,
        }),
      });
    }
  });

  it("three release_event records forming an otherwise-LEGAL prepared -> deployed|preview -> verified|preview D5 lifecycle, all sharing one event_id -> evaluation_status=invalid_input (terra's exact repro: \"同一 event_id=evt-dup\" -- reference rejects with duplicate_event_id, src/core/fold.ts's foldLedger; the events individually parse fine AND fold legally, so round C's own foldAttemptEvents illegal_transition check cannot catch this -- only a ledger-wide identity check can)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const sharedEventId = "evt-dup";
    const preparedEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "prepared",
        environment: null,
        bundle_digest: bundle.digest,
        occurred_at: "2026-08-21T00:00:00Z",
        event_id: sharedEventId,
      }),
      "2026-08-21T00:00:00Z",
    );
    const previewDeployedEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "deployed",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: "2026-08-22T00:00:00Z",
        event_id: sharedEventId,
      }),
      "2026-08-22T00:00:00Z",
    );
    const previewVerifiedEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "verified",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: EVALUATION_CUT,
        event_id: sharedEventId,
      }),
      EVALUATION_CUT,
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, preparedEvent, previewDeployedEvent, previewVerifiedEvent],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.candidate_receipt).toBeNull();
    expect(result.predicate_observations).toEqual([]);
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "release_event",
          reason: "duplicate_event_id",
          event_id: sharedEventId,
        }),
      }),
    ]);
  });

  it("does NOT flag a legitimate release_event collection where every event's release_id matches its own bundle and every event_id is unique (negative control -- fullyResolvedInput itself stays evaluated, never invalid_input)", () => {
    const result = evaluate(fullyResolvedInput());
    expect(result.evaluation_status).toBe("evaluated");
  });
});

describe("evaluate: must (terra round E, 2026-08-27) -- event_id uniqueness must be checked over every record OCCURRENCE, before resolver.ts's digest collapse to one survivor per digest", () => {
  it("the exact SAME release_event envelope pushed twice into records[] -> evaluation_status=invalid_input, duplicate_event_id (terra's exact repro: pushing a structuredClone of an existing release_event record; resolver.ts's byDigest collapses the two byte-identical envelopes into one survivor, which previously hid the duplicate from the event_id uniqueness check entirely -- the reference src/core/fold.ts's foldLedger folds input.records directly and rejects this)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const preparedEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "prepared",
        environment: null,
        bundle_digest: bundle.digest,
        occurred_at: "2026-08-21T00:00:00Z",
      }),
      "2026-08-21T00:00:00Z",
    );
    const duplicatedPreparedEvent: ExactRecord = structuredClone(preparedEvent);
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, preparedEvent, duplicatedPreparedEvent],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.candidate_receipt).toBeNull();
    expect(result.predicate_observations).toEqual([]);
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "release_event",
          reason: "duplicate_event_id",
          event_id: (preparedEvent.content as { event_id: string }).event_id,
        }),
      }),
    ]);
  });

  it("three release_event records with genuinely DIFFERENT content (distinct digests) but sharing one event_id -> evaluation_status=invalid_input, duplicate_event_id (the non-duplicate-envelope shape of the same violation -- distinct digests must still be caught, not only byte-identical duplicates)", () => {
    const manifest = manifestRecord();
    const bundle = bundleRecord();
    const sharedEventId = "evt-dup-distinct-content";
    const preparedEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "prepared",
        environment: null,
        bundle_digest: bundle.digest,
        occurred_at: "2026-08-21T00:00:00Z",
        event_id: sharedEventId,
      }),
      "2026-08-21T00:00:00Z",
    );
    const previewDeployedEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "deployed",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: "2026-08-22T00:00:00Z",
        event_id: sharedEventId,
      }),
      "2026-08-22T00:00:00Z",
    );
    const previewVerifiedEvent = record(
      "release_event",
      validEventContent({
        release_id: RELEASE_ID,
        kind: "verified",
        environment: "preview",
        bundle_digest: bundle.digest,
        occurred_at: EVALUATION_CUT,
        event_id: sharedEventId,
      }),
      EVALUATION_CUT,
    );
    const input = baseInput({
      subject: {
        bundle_digest: bundle.digest,
        selection_manifest_digest: manifest.digest,
        target: "production",
      },
      records: [manifest, bundle, preparedEvent, previewDeployedEvent, previewVerifiedEvent],
    });
    const result = evaluate(input);
    expect(result.evaluation_status).toBe("invalid_input");
    expect(result.input_errors).toEqual([
      expect.objectContaining({
        code: "record_invalid",
        params: expect.objectContaining({
          kind: "release_event",
          reason: "duplicate_event_id",
          event_id: sharedEventId,
        }),
      }),
    ]);
  });
});
