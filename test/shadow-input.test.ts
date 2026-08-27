import { describe, expect, it } from "vitest";
import {
  type CandidateReceipt,
  type ShadowEvaluation,
  type ShadowEvaluationInput,
  validateShadowEvaluation,
  validateShadowEvaluationInput,
} from "../src/shadow/input.js";

// Deterministic sha256:<hex>-shaped test digest, one hex digit per label letter (a-h below map
// to distinct digits 1-8) -- never a real sha256, but always schema-valid hex.
const HEX_DIGITS = "0123456789abcdef";
const SHA = (label: string) => `sha256:${(HEX_DIGITS[label.charCodeAt(0) % 16] ?? "0").repeat(64)}`;

function validInput(): ShadowEvaluationInput {
  return {
    schema_version: "shadow-evaluation-input/v0",
    evaluation_cut: "2026-08-23T00:00:00Z",
    policy: { digest: SHA("a"), effective_risk: "medium" },
    contract_pin: { playbook_commit: "f9f0c127588f60fd299a02859c9f70f0b81a9dcc" },
    subject: {
      bundle_digest: SHA("b"),
      selection_manifest_digest: SHA("c"),
      target: "production",
    },
    records: [
      {
        kind: "release_evidence_bundle",
        digest: SHA("d"),
        content: { release_id: "r-1" },
      },
    ],
  };
}

describe("validateShadowEvaluationInput", () => {
  it("accepts a well-formed shadow-evaluation-input/v0", () => {
    expect(validateShadowEvaluationInput(validInput())).toEqual([]);
  });

  it("rejects a wrong schema_version", () => {
    const input = { ...validInput(), schema_version: "shadow-evaluation-input/v1" };
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });

  it("rejects a missing required top-level field", () => {
    const input = validInput() as Partial<ShadowEvaluationInput>;
    // biome-ignore lint/performance/noDelete: `required` is checked via `in`, so undefined !== missing
    delete input.evaluation_cut;
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });

  it("rejects an additional top-level property", () => {
    const input = { ...validInput(), extra: "not allowed" };
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });

  it("rejects an out-of-enum effective_risk", () => {
    const input = validInput();
    input.policy.effective_risk = "critical" as ShadowEvaluationInput["policy"]["effective_risk"];
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });

  it("rejects a bundle_digest that isn't sha256:<hex>", () => {
    const input = validInput();
    input.subject.bundle_digest = "not-a-digest";
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });

  it("rejects a record kind outside the closed set", () => {
    const input = validInput();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately testing an invalid enum value
    (input.records[0] as any).kind = "made_up_kind";
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });

  // round C, must-2 residual: policy.digest is now a two-way choice -- an honest null +
  // absent_reason, or a real (resolution-required, checked by evaluate.ts, not this schema)
  // digest -- and the schema fixes the shape of that choice.
  it("accepts policy.digest=null with a matching absent_reason", () => {
    const input = validInput();
    input.policy = {
      digest: null,
      absent_reason: { code: "policy_snapshot_absent", note: "no snapshot for this replay" },
      effective_risk: "medium",
    };
    expect(validateShadowEvaluationInput(input)).toEqual([]);
  });

  it("rejects policy.digest=null WITHOUT absent_reason", () => {
    const input = validInput();
    input.policy = { digest: null, effective_risk: "medium" } as ShadowEvaluationInput["policy"];
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });

  it("rejects a non-null policy.digest that ALSO carries absent_reason (the two-way choice is mutually exclusive)", () => {
    const input = validInput();
    input.policy = {
      digest: SHA("a"),
      absent_reason: { code: "policy_snapshot_absent", note: "should not be here" },
      effective_risk: "medium",
    } as ShadowEvaluationInput["policy"];
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });

  it("rejects an absent_reason.code outside the closed set", () => {
    const input = validInput();
    input.policy = {
      digest: null,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately testing an invalid enum value
      absent_reason: { code: "made_up_code" as any, note: "n" },
      effective_risk: "medium",
    };
    expect(validateShadowEvaluationInput(input)).not.toEqual([]);
  });
});

function validCandidateReceipt(): CandidateReceipt {
  return {
    schema_version: "promotion-receipt/v0",
    receipt_id: "receipt-1",
    evaluated_at: "2026-08-23T00:00:00Z",
    evaluation_phase: "pre_promotion",
    subject: {
      bundle_digest: SHA("b"),
      selection_manifest_digest: SHA("c"),
      target: "production",
    },
    policy_digest: SHA("a"),
    effective_risk: "medium",
    semantic_digest: SHA("e"),
    predicates: [
      {
        predicate_id: "artifact_identity",
        applicability: "applicable",
        status: "satisfied",
        evidence_refs: [{ kind: "release_evidence", ref: "r-1", digest: SHA("f") }],
      },
    ],
    verdict: "ready_for_approval",
  };
}

function validEvaluation(overrides: Partial<ShadowEvaluation> = {}): ShadowEvaluation {
  return {
    schema_version: "shadow-evaluation/v0",
    mode: "shadow_only",
    evaluation_cut: "2026-08-23T00:00:00Z",
    evaluator: { version: "0.1.0", playbook_contract_commit: "f9f0c127" },
    input_manifest: {
      records: [{ kind: "release_evidence_bundle", digest: SHA("d") }],
      digest: SHA("g"),
    },
    evaluation_status: "unknown",
    unknown_reasons: [{ code: "unknown_structural", params: {} }],
    input_errors: [],
    predicate_observations: [],
    candidate_receipt: null,
    record_digest: SHA("h"),
    ...overrides,
  };
}

describe("validateShadowEvaluation", () => {
  it("accepts a well-formed evaluation_status=unknown wrapper (candidate_receipt null, a reason present)", () => {
    expect(validateShadowEvaluation(validEvaluation())).toEqual([]);
  });

  it("accepts a well-formed evaluation_status=evaluated wrapper with a schema-valid candidate_receipt", () => {
    const evaluation = validEvaluation({
      evaluation_status: "evaluated",
      unknown_reasons: [],
      predicate_observations: [
        {
          predicate_id: "artifact_identity",
          applicability: "applicable",
          status: "satisfied",
          evidence_refs: [{ kind: "release_evidence", ref: "r-1", digest: SHA("f") }],
        },
      ],
      candidate_receipt: validCandidateReceipt(),
    });
    expect(validateShadowEvaluation(evaluation)).toEqual([]);
  });

  it("rejects mode !== shadow_only", () => {
    const evaluation = { ...validEvaluation(), mode: "live" };
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });

  it("rejects evaluation_status=evaluated with a null candidate_receipt", () => {
    const evaluation = validEvaluation({ evaluation_status: "evaluated", unknown_reasons: [] });
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });

  it("rejects evaluation_status=unknown with a non-null candidate_receipt", () => {
    const evaluation = validEvaluation({ candidate_receipt: validCandidateReceipt() });
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });

  it("rejects evaluation_status=unknown with an empty unknown_reasons", () => {
    const evaluation = validEvaluation({ unknown_reasons: [] });
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });

  it("rejects a predicate_observation with status=unknown and no reason", () => {
    const evaluation = validEvaluation({
      predicate_observations: [
        {
          predicate_id: "verification_coverage",
          applicability: "applicable",
          status: "unknown",
          evidence_refs: [],
        },
      ],
    });
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });

  it("accepts a predicate_observation with status=unknown and a reason", () => {
    const evaluation = validEvaluation({
      predicate_observations: [
        {
          predicate_id: "verification_coverage",
          applicability: "applicable",
          status: "unknown",
          evidence_refs: [],
          reason: { code: "lane_ref_omitted", params: { omission_code: "other" } },
        },
      ],
    });
    expect(validateShadowEvaluation(evaluation)).toEqual([]);
  });

  it("rejects a candidate_receipt missing a required receipt field", () => {
    const receipt = validCandidateReceipt() as Partial<CandidateReceipt>;
    // biome-ignore lint/performance/noDelete: see the same note on the earlier delete in this file.
    delete receipt.verdict;
    const evaluation = validEvaluation({
      evaluation_status: "evaluated",
      unknown_reasons: [],
      candidate_receipt: receipt as CandidateReceipt,
    });
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });

  it("rejects an additional top-level property on the wrapper", () => {
    const evaluation = { ...validEvaluation(), extra: true };
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });

  it("accepts evaluation_status=invalid_input with a populated input_errors and no receipt", () => {
    const evaluation = validEvaluation({
      evaluation_status: "invalid_input",
      unknown_reasons: [],
      input_errors: [
        { code: "digest_mismatch", params: { declared: SHA("a"), recomputed: SHA("b") } },
      ],
    });
    expect(validateShadowEvaluation(evaluation)).toEqual([]);
  });

  it("rejects evaluation_status=invalid_input with an empty input_errors", () => {
    const evaluation = validEvaluation({ evaluation_status: "invalid_input", unknown_reasons: [] });
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });

  it("rejects evaluation_status=evaluated with a non-empty input_errors", () => {
    const evaluation = validEvaluation({
      evaluation_status: "evaluated",
      unknown_reasons: [],
      candidate_receipt: validCandidateReceipt(),
      input_errors: [{ code: "record_invalid", params: {} }],
    });
    expect(validateShadowEvaluation(evaluation)).not.toEqual([]);
  });
});
