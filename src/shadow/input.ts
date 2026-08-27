// shadow-evaluation-input/v0 and shadow-evaluation/v0: this evaluator's own implementation-
// internal draft schemas (spec.md "I/O 契約 -- 実装内 draft schema、契約昇格は replay 実績
//後"). Neither is a playbook contract -- promotion-receipt/v0 is the only vendored contract a
// value here is ever checked AGAINST (candidate_receipt, structurally), by chunk 2's evaluate.ts
// and by tests, using the real vendored schema file (fs is fine there; this file never touches
// fs itself).
//
// Validation reuses the vendored minimal JSON Schema validator (#vendor/schema-validator.mjs)
// the same way src/core/bundle.ts and event.ts do, but calls its `validateAgainst` directly
// against an in-memory schema object instead of `createValidator(dir).validate(filename, ...)` --
// the latter reads the schema file off disk on every call, which is fs I/O and forbidden in
// shadow core (spec.md "決定論": "fs は resolver の入力読み込み層だけ"). `createValidator("")`
// itself does no I/O (the returned closures only touch fs when asked to load a *named file*,
// which nothing here does), so reusing its `validateAgainst` here stays fs-free.

import { createValidator } from "#vendor/schema-validator.mjs";
import {
  INPUT_ERROR_CODES,
  type InputError,
  UNKNOWN_REASON_CODES,
  type UnknownReason,
} from "./reasons.js";
import { TIMESTAMP_PATTERN } from "./time.js";

const { validateAgainst } = createValidator("");

/** Runs `instance` against an in-memory JSON Schema object (no fs -- see this file's header
 * comment). Exported for reuse by contracts.ts, which needs the same in-memory validation
 * primitive for record CONTENT schemas. */
export function runSchema(schema: object, instance: unknown): string[] {
  const errors: string[] = [];
  validateAgainst(schema, instance, schema, "$", errors);
  return errors;
}

const SHA256_REF_PATTERN = "^sha256:[0-9a-f]{64}$";

// ---------------------------------------------------------------------------
// shadow-evaluation-input/v0
// ---------------------------------------------------------------------------

/** The closed set of exact-record kinds this evaluator's input pool can carry. `resolver.ts`
 * resolves records by digest only, regardless of kind -- `kind` is metadata for callers
 * (evaluate.ts, chunk 2), never a resolution key. */
export const EXACT_RECORD_KINDS = [
  "release_evidence_bundle",
  "release_event",
  "review_finding_record",
  "verification_record",
  "selection_manifest",
  "policy_snapshot",
  "other",
] as const;

export type ExactRecordKind = (typeof EXACT_RECORD_KINDS)[number];

/** One immutable, content-addressed record in the input pool. `digest` is the record's
 * content-address key (spec.md: resolution is by digest, never by path/ID) -- `resolver.ts`
 * recomputes it from `content` and rejects a mismatch as `digest_mismatch` rather than trusting
 * the declared value. `observed_at`, when present, is the timestamp this record became visible
 * at in the real world (a release_event's `occurred_at`, a review-findings record's
 * `recorded_at`, ...) -- absent for records with no time axis (e.g. a sealed bundle, timeless
 * once sealed). Never defaulted, never inferred from anything else. */
export interface ExactRecord {
  kind: ExactRecordKind;
  digest: string;
  observed_at?: string;
  content: unknown;
}

const exactRecordSchema = {
  type: "object",
  required: ["kind", "digest", "content"],
  additionalProperties: false,
  properties: {
    kind: { enum: [...EXACT_RECORD_KINDS] },
    digest: { type: "string", pattern: SHA256_REF_PATTERN },
    observed_at: { type: "string", pattern: TIMESTAMP_PATTERN },
    content: {},
  },
} as const;

/** Closed set (terra review round C, must-2 residual): the only reason an evaluation may
 * honestly declare it has no policy snapshot for this evaluation at all -- as opposed to a
 * digest that was supplied but simply failed to resolve, which is a referent_unresolved
 * wrapper-gate failure (evaluate.ts), never this. */
export const POLICY_ABSENT_REASON_CODES = ["policy_snapshot_absent"] as const;
export type PolicyAbsentReasonCode = (typeof POLICY_ABSENT_REASON_CODES)[number];

export interface PolicyAbsentReason {
  code: PolicyAbsentReasonCode;
  note: string;
}

export interface ShadowEvaluationInput {
  schema_version: "shadow-evaluation-input/v0";
  evaluation_cut: string;
  policy: {
    /** `null` means "no policy snapshot was captured for this evaluation" -- an honest,
     * documented absence (see `absent_reason`), never a placeholder digest that happens not to
     * resolve (terra review round C: "「未解決でも黙って receipt 生成」経路を削除"). A non-null
     * digest is a real pointer that MUST resolve to a `policy_snapshot`-kind record in the pool
     * (evaluate.ts's wrapper-level gate) -- when it does not, evaluation_status becomes
     * "unknown" (reason=referent_unresolved), the same discipline must-2 already applies to
     * `subject.bundle_digest`. */
    digest: string | null;
    /** Required exactly when `digest` is null, forbidden otherwise (schema-enforced below) --
     * mirrors `Bundle.lane_ref_omitted`/`review_omitted`'s own "an omission must be a declared,
     * closed-code fact, never a silent gap" discipline. */
    absent_reason?: PolicyAbsentReason;
    effective_risk: "low" | "medium" | "high";
  };
  contract_pin: {
    playbook_commit: string;
  };
  subject: {
    bundle_digest: string;
    selection_manifest_digest: string;
    target: "preview" | "staging" | "production";
    /** Whole-record digest of the review-findings/v1 record that grounds this bundle's
     * `review.decision` (terra review must-2: "review は finding record を参照せず bundle の
     * decision だけ...で satisfied"). `null`/absent when not supplied -- review_admissibility can
     * then never resolve past "unknown" for a non-null bundle.review (evaluate.ts). */
    review_finding_digest?: string | null;
    /** Whole-record digest of the PREVIOUS release_evidence_bundle named by
     * `bundle.rollback.previous_release_id` (terra review must-2: "rollback は previous bundle を
     * 要求せず release ID が一致する event だけで satisfied"). `null`/absent when not supplied --
     * rollback_target_valid can then never resolve past "unknown" for a non-null rollback target
     * (evaluate.ts). */
    rollback_previous_bundle_digest?: string | null;
  };
  records: ExactRecord[];
}

export const SHADOW_EVALUATION_INPUT_SCHEMA_V0 = {
  type: "object",
  required: ["schema_version", "evaluation_cut", "policy", "contract_pin", "subject", "records"],
  additionalProperties: false,
  properties: {
    schema_version: { const: "shadow-evaluation-input/v0" },
    evaluation_cut: { type: "string", pattern: TIMESTAMP_PATTERN },
    policy: {
      type: "object",
      required: ["digest", "effective_risk"],
      additionalProperties: false,
      properties: {
        digest: { type: ["string", "null"], pattern: SHA256_REF_PATTERN },
        absent_reason: {
          type: "object",
          required: ["code", "note"],
          additionalProperties: false,
          properties: {
            code: { enum: [...POLICY_ABSENT_REASON_CODES] },
            note: { type: "string", minLength: 1 },
          },
        },
        effective_risk: { enum: ["low", "medium", "high"] },
      },
      allOf: [
        {
          if: { required: ["digest"], properties: { digest: { type: "null" } } },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
          then: { required: ["absent_reason"] },
          else: { not: { required: ["absent_reason"] } },
        },
      ],
    },
    contract_pin: {
      type: "object",
      required: ["playbook_commit"],
      additionalProperties: false,
      properties: {
        playbook_commit: { type: "string", minLength: 1 },
      },
    },
    subject: {
      type: "object",
      required: ["bundle_digest", "selection_manifest_digest", "target"],
      additionalProperties: false,
      properties: {
        bundle_digest: { type: "string", pattern: SHA256_REF_PATTERN },
        selection_manifest_digest: { type: "string", pattern: SHA256_REF_PATTERN },
        target: { enum: ["preview", "staging", "production"] },
        review_finding_digest: { type: ["string", "null"], pattern: SHA256_REF_PATTERN },
        rollback_previous_bundle_digest: { type: ["string", "null"], pattern: SHA256_REF_PATTERN },
      },
    },
    records: { type: "array", items: exactRecordSchema },
  },
} as const;

/** Structural validation only (no fs, no cross-record resolution -- see resolver.ts for that).
 * Returns an empty array when valid. */
export function validateShadowEvaluationInput(input: unknown): string[] {
  return runSchema(SHADOW_EVALUATION_INPUT_SCHEMA_V0, input);
}

// ---------------------------------------------------------------------------
// shadow-evaluation/v0
// ---------------------------------------------------------------------------

/** R11 pre_promotion closed set, mirrored from the vendored promotion-receipt/v0 schema
 * (vendor/playbook-contracts/promotion-receipt/v0/promotion-receipt.schema.json). This
 * evaluator only ever produces `pre_promotion` receipts (spec.md: "pre_promotion 述語6種...を
 * 決定論的に評価する") -- `deployed_artifact_readback` (the sole post_deploy predicate) is out
 * of scope entirely, not merely unimplemented. */
export const PRE_PROMOTION_PREDICATE_IDS = [
  "artifact_identity",
  "review_admissibility",
  "verification_coverage",
  "preview_verified",
  "rollback_target_valid",
  "privilege_boundary",
] as const;

export type PrePromotionPredicateId = (typeof PRE_PROMOTION_PREDICATE_IDS)[number];

export type PredicateApplicability = "applicable" | "not_applicable";
export type PredicateStatus = "satisfied" | "contradicted" | "unknown";

export interface EvidenceRef {
  kind: "review_finding" | "release_evidence" | "other";
  ref: string;
  digest: string;
}

const evidenceRefSchema = {
  type: "object",
  required: ["kind", "ref", "digest"],
  additionalProperties: false,
  properties: {
    kind: { enum: ["review_finding", "release_evidence", "other"] },
    ref: { type: "string", minLength: 1 },
    digest: { type: "string", pattern: SHA256_REF_PATTERN },
  },
} as const;

/** One predicate's full internal observation -- richer than what promotion-receipt/v0's own
 * schema can carry (it has no `reason` field; see spec.md "unknown の分類"). `evaluate.ts`
 * (chunk 2) is the only place these get computed; `candidate_receipt.predicates` is a mechanical
 * projection of these onto the receipt's schema-valid shape (spec.md: "別ロジックで再計算し
 * ない") -- dropping `reason`, never recomputing status/applicability from anything else. */
export interface PredicateObservation {
  predicate_id: PrePromotionPredicateId;
  applicability: PredicateApplicability;
  status: PredicateStatus;
  evidence_refs: EvidenceRef[];
  /** Present exactly when status === "unknown" (schema-enforced below). */
  reason?: UnknownReason;
  notes?: string;
}

const predicateObservationSchema = {
  type: "object",
  required: ["predicate_id", "applicability", "status", "evidence_refs"],
  additionalProperties: false,
  properties: {
    predicate_id: { enum: [...PRE_PROMOTION_PREDICATE_IDS] },
    applicability: { enum: ["applicable", "not_applicable"] },
    status: { enum: ["satisfied", "contradicted", "unknown"] },
    evidence_refs: { type: "array", items: evidenceRefSchema },
    reason: {
      type: "object",
      required: ["code", "params"],
      additionalProperties: false,
      properties: {
        code: { enum: [...UNKNOWN_REASON_CODES] },
        params: { type: "object" },
      },
    },
    notes: { type: "string", minLength: 1 },
  },
  allOf: [
    {
      if: { required: ["status"], properties: { status: { const: "unknown" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword, not a thenable
      then: { required: ["reason"] },
    },
  ],
} as const;

/** `candidate_receipt.predicates[]` shape -- the promotion-receipt/v0-schema-valid projection of
 * a `PredicateObservation` (no `reason`; see the type doc above). Field-for-field mirror of the
 * vendored schema's `predicates[]` item; NOT re-derived from it at runtime (no fs here), so a
 * drift between this and the vendored schema is a conformance-test finding, not a silent gap --
 * see docs/spec/I-2026-08-27-f-shadow-evaluator/implement-notes.md for the follow-up this
 * implies for chunk 2/3. */
export interface ReceiptPredicate {
  predicate_id: PrePromotionPredicateId;
  applicability: PredicateApplicability;
  status: PredicateStatus;
  evidence_refs: EvidenceRef[];
  notes?: string;
}

export interface CandidateReceipt {
  schema_version: "promotion-receipt/v0";
  receipt_id: string;
  evaluated_at: string;
  evaluation_phase: "pre_promotion";
  subject: {
    bundle_digest: string;
    selection_manifest_digest: string;
    target: "preview" | "staging" | "production";
  };
  policy_digest: string;
  effective_risk: "low" | "medium" | "high";
  semantic_digest: string;
  predicates: ReceiptPredicate[];
  verdict: "ready_for_approval" | "ineligible" | "abstained";
}

const candidateReceiptSchema = {
  type: "object",
  required: [
    "schema_version",
    "receipt_id",
    "evaluated_at",
    "evaluation_phase",
    "subject",
    "policy_digest",
    "effective_risk",
    "semantic_digest",
    "predicates",
    "verdict",
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: "promotion-receipt/v0" },
    receipt_id: { type: "string", minLength: 1 },
    evaluated_at: { type: "string", pattern: TIMESTAMP_PATTERN },
    evaluation_phase: { const: "pre_promotion" },
    subject: {
      type: "object",
      required: ["bundle_digest", "selection_manifest_digest", "target"],
      additionalProperties: false,
      properties: {
        bundle_digest: { type: "string", pattern: SHA256_REF_PATTERN },
        selection_manifest_digest: { type: "string", pattern: SHA256_REF_PATTERN },
        target: { enum: ["preview", "staging", "production"] },
      },
    },
    policy_digest: { type: "string", pattern: SHA256_REF_PATTERN },
    effective_risk: { enum: ["low", "medium", "high"] },
    semantic_digest: { type: "string", pattern: SHA256_REF_PATTERN },
    predicates: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["predicate_id", "applicability", "status", "evidence_refs"],
        additionalProperties: false,
        properties: {
          predicate_id: { enum: [...PRE_PROMOTION_PREDICATE_IDS] },
          applicability: { enum: ["applicable", "not_applicable"] },
          status: { enum: ["satisfied", "contradicted", "unknown"] },
          evidence_refs: { type: "array", items: evidenceRefSchema },
          notes: { type: "string", minLength: 1 },
        },
      },
    },
    verdict: { enum: ["ready_for_approval", "ineligible", "abstained"] },
  },
} as const;

const inputManifestRefSchema = {
  type: "object",
  required: ["kind", "digest"],
  additionalProperties: false,
  properties: {
    kind: { type: "string", minLength: 1 },
    digest: { type: "string", pattern: SHA256_REF_PATTERN },
  },
} as const;

const unknownReasonSchema = {
  type: "object",
  required: ["code", "params"],
  additionalProperties: false,
  properties: {
    code: { enum: [...UNKNOWN_REASON_CODES] },
    params: { type: "object" },
  },
} as const;

/** Mirrors unknownReasonSchema's shape but against the disjoint InputErrorCode namespace
 * (reasons.ts "入力エラーは別 namespace") -- this is `ShadowEvaluation.input_errors`'s item
 * shape, never mixed with UnknownReason in the same array. */
const inputErrorSchema = {
  type: "object",
  required: ["code", "params"],
  additionalProperties: false,
  properties: {
    code: { enum: [...INPUT_ERROR_CODES] },
    params: { type: "object" },
  },
} as const;

export type EvaluationStatus = "evaluated" | "unknown" | "invalid_input";

export interface ShadowEvaluation {
  schema_version: "shadow-evaluation/v0";
  mode: "shadow_only";
  evaluation_cut: string;
  evaluator: {
    version: string;
    playbook_contract_commit: string;
  };
  input_manifest: {
    records: Array<{ kind: string; digest: string }>;
    digest: string;
  };
  evaluation_status: EvaluationStatus;
  /** Non-empty exactly when evaluation_status === "unknown" (schema-enforced below) -- why the
   * WHOLE evaluation (not one predicate) could not produce a receipt, e.g. selection_manifest
   * or the bundle itself not resolving in the given exact-record pool. */
  unknown_reasons: UnknownReason[];
  /** Non-empty exactly when evaluation_status === "invalid_input" (schema-enforced below) --
   * this is chunk 2's own addition to chunk 1's wrapper shape: chunk 1 defined
   * `evaluation_status=invalid_input` and the disjoint InputErrorCode namespace (reasons.ts) but
   * never gave the wrapper a field to actually carry a pool.errors (resolver.ts) diagnosis, which
   * would have made an invalid_input record silently unexplained -- exactly the kind of thing
   * this evaluator exists to never do. `unknown_reasons` is NOT reused for this (disjoint
   * namespace, reasons.ts's own header comment: "Two separate namespaces, deliberately not
   * unioned into one enum"). */
  input_errors: InputError[];
  predicate_observations: PredicateObservation[];
  candidate_receipt: CandidateReceipt | null;
  record_digest: string;
}

export const SHADOW_EVALUATION_SCHEMA_V0 = {
  type: "object",
  required: [
    "schema_version",
    "mode",
    "evaluation_cut",
    "evaluator",
    "input_manifest",
    "evaluation_status",
    "unknown_reasons",
    "input_errors",
    "predicate_observations",
    "candidate_receipt",
    "record_digest",
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: "shadow-evaluation/v0" },
    mode: { const: "shadow_only" },
    evaluation_cut: { type: "string", pattern: TIMESTAMP_PATTERN },
    evaluator: {
      type: "object",
      required: ["version", "playbook_contract_commit"],
      additionalProperties: false,
      properties: {
        version: { type: "string", minLength: 1 },
        playbook_contract_commit: { type: "string", minLength: 1 },
      },
    },
    input_manifest: {
      type: "object",
      required: ["records", "digest"],
      additionalProperties: false,
      properties: {
        records: { type: "array", items: inputManifestRefSchema },
        digest: { type: "string", pattern: SHA256_REF_PATTERN },
      },
    },
    evaluation_status: { enum: ["evaluated", "unknown", "invalid_input"] },
    unknown_reasons: { type: "array", items: unknownReasonSchema },
    input_errors: { type: "array", items: inputErrorSchema },
    predicate_observations: { type: "array", items: predicateObservationSchema },
    candidate_receipt: { oneOf: [{ type: "null" }, candidateReceiptSchema] },
    record_digest: { type: "string", pattern: SHA256_REF_PATTERN },
  },
  allOf: [
    {
      if: {
        required: ["evaluation_status"],
        properties: { evaluation_status: { const: "invalid_input" } },
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword, not a thenable
      then: {
        properties: {
          candidate_receipt: { type: "null" },
          predicate_observations: { maxItems: 0 },
          input_errors: { minItems: 1 },
        },
      },
    },
    {
      if: {
        required: ["evaluation_status"],
        properties: { evaluation_status: { const: "unknown" } },
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword, not a thenable
      then: {
        properties: {
          candidate_receipt: { type: "null" },
          unknown_reasons: { minItems: 1 },
          input_errors: { maxItems: 0 },
        },
      },
    },
    {
      if: {
        required: ["evaluation_status"],
        properties: { evaluation_status: { const: "evaluated" } },
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword, not a thenable
      then: {
        properties: {
          candidate_receipt: { type: "object" },
          unknown_reasons: { maxItems: 0 },
          input_errors: { maxItems: 0 },
        },
      },
    },
  ],
} as const;

/** Structural validation only (no fs; the vendored promotion-receipt/v0 file schema is the
 * authority for `candidate_receipt`'s full fidelity -- see this file's header comment and
 * `candidateReceiptSchema`'s doc comment). Returns an empty array when valid. */
export function validateShadowEvaluation(evaluation: unknown): string[] {
  return runSchema(SHADOW_EVALUATION_SCHEMA_V0, evaluation);
}
