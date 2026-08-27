// Full-record contract validation layer (terra review must-1, 2026-08-27:
// "predicate 実行前に、消費する bundle/event/review-finding/verification record の schema_version
// ・全schema・semantic MUST を純粋な検証層で確認し、違反はinvalid_input/record_invalid、未対応
// versionはunsupported_record_versionにする。kind一致だけでsatisfiedにしないでください。").
//
// Pure -- no fs/network/process.env (spec.md "決定論"). The two contracts this repo does NOT
// vendor (release-evidence/v0's bundle and event schemas -- they live only in the external
// ai-agent-skills-playbook checkout pointed at by RELEASE_EVIDENCE_CONTRACTS_DIR, read via
// src/core/env.ts's getContractsDir(), which is fs+env and therefore banned in shadow core) are
// hand-mirrored here as in-memory JSON Schema objects, the SAME discipline input.ts's own
// `candidateReceiptSchema` already uses for promotion-receipt/v0 (implement-notes.md "非自明な
// 判断 2"): a faithful, byte-for-byte-sourced copy of the real schema's required/properties/
// enum/pattern/allOf/oneOf rules, checked in-process with no I/O. review-findings/v1 IS vendored
// in this repo (vendor/playbook-contracts/review-findings/v1/review-findings.schema.json) but is
// mirrored the same way rather than imported, for the same reason input.ts gives for not loading
// even ITS OWN files at runtime: a static/dynamic import of a JSON file still means module-load-
// time fs I/O, which this file's callers (resolver.ts, in turn evaluate.ts) must never touch.
// verification_record has no external contract at all (sol's design log never named one) -- V0
// is this evaluator's own internal draft schema, same status as shadow-evaluation-input/v0.
//
// Full-fidelity verification against the REAL vendored/external files (not this hand mirror)
// stays a CLI/test-layer concern, same split candidate_receipt already has between input.ts's
// mirror and shadow-cli/main.ts's `verifyCandidateReceiptFullFidelity`.

import { scanPersonalDimensions } from "#vendor/personal-dimensions.mjs";
import type { Bundle } from "../core/types.js";
import { dedupe } from "../core/util.js";
import type { ExactRecord, ExactRecordKind } from "./input.js";
import { runSchema } from "./input.js";
import { type InputError, inputError } from "./reasons.js";
import { TIMESTAMP_PATTERN } from "./time.js";

const SHA256_REF_PATTERN = "^sha256:[0-9a-f]{64}$";
const HASH_HEX_PATTERN = "^([0-9a-f]{40}|[0-9a-f]{64})$";

// ---------------------------------------------------------------------------
// Hand mirror of the external release-evidence/v0 bundle schema
// (ai-agent-skills-playbook: contracts/release-evidence/v0/release-evidence-bundle.schema.json).
// ---------------------------------------------------------------------------

const RELEASE_EVIDENCE_BUNDLE_CONTENT_SCHEMA = {
  type: "object",
  required: [
    "schema_version",
    "release_id",
    "source",
    "lane_ref",
    "review",
    "artifacts",
    "build",
    "known_deviations",
    "rollback",
    "integrity",
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: "release-evidence/v0" },
    release_id: { type: "string", minLength: 1 },
    source: {
      type: "object",
      required: ["repo", "commit_sha", "tree_digest", "resolution"],
      additionalProperties: false,
      properties: {
        repo: { type: "string", minLength: 1, pattern: "^[^/\\s]+/[^/\\s]+$" },
        commit_sha: { type: "string", pattern: HASH_HEX_PATTERN },
        tree_digest: { type: "string", pattern: HASH_HEX_PATTERN },
        ref: { type: "string", minLength: 1 },
        resolution: { enum: ["git_tree"] },
      },
    },
    lane_ref: {
      oneOf: [
        {
          type: "object",
          required: [
            "lane_id",
            "intent_digest",
            "spec_digest",
            "consensus_ack_digest",
            "verification_digest",
          ],
          additionalProperties: false,
          properties: {
            lane_id: { type: "string", minLength: 1 },
            intent_digest: { type: "string", pattern: SHA256_REF_PATTERN },
            spec_digest: { type: "string", pattern: SHA256_REF_PATTERN },
            consensus_ack_digest: { type: "string", pattern: SHA256_REF_PATTERN },
            premise_evidence_digest: { type: "string", pattern: SHA256_REF_PATTERN },
            verification_digest: { type: "string", pattern: SHA256_REF_PATTERN },
            matrix_digest: { type: "string", pattern: SHA256_REF_PATTERN },
          },
        },
        { type: "null" },
      ],
    },
    lane_ref_omitted: {
      type: "object",
      required: ["code", "note"],
      additionalProperties: false,
      properties: {
        code: {
          enum: [
            "no_lane_scheduled_rebuild",
            "multiple_contributing_lanes",
            "legacy_release_predates_contract",
            "other",
          ],
        },
        note: { type: "string", minLength: 1 },
      },
    },
    review: {
      oneOf: [
        {
          type: "object",
          required: ["pr", "head_sha", "decision"],
          additionalProperties: false,
          properties: {
            pr: { type: "integer", minimum: 1 },
            head_sha: { type: "string", pattern: HASH_HEX_PATTERN },
            decision: { enum: ["approved", "commented", "self_merged"] },
          },
        },
        { type: "null" },
      ],
    },
    review_omitted: {
      type: "object",
      required: ["code", "note"],
      additionalProperties: false,
      properties: {
        code: {
          enum: [
            "scheduled_rebuild_deploys_reviewed_main",
            "legacy_release_predates_contract",
            "other",
          ],
        },
        note: { type: "string", minLength: 1 },
      },
    },
    artifacts: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["kind", "digest"],
        additionalProperties: false,
        properties: {
          kind: { enum: ["package", "static_site", "container", "binary", "other"] },
          digest: { type: "string", pattern: SHA256_REF_PATTERN },
          content_manifest_digest: { type: "string", pattern: SHA256_REF_PATTERN },
          artifact_ref: {
            type: "object",
            required: ["registry", "package", "version", "verifiability"],
            additionalProperties: false,
            properties: {
              registry: { enum: ["npm", "pypi", "github-pages", "other"] },
              package: { type: "string", minLength: 1 },
              version: { type: "string", minLength: 1 },
              distribution: { type: "string", minLength: 1 },
              registry_url: { type: "string", minLength: 1 },
              verifiability: { enum: ["registry_metadata", "requires_fetch", "unverifiable"] },
              unverifiable_reason: { type: "string", minLength: 1 },
            },
            allOf: [
              {
                if: { required: ["registry"], properties: { registry: { const: "pypi" } } },
                // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
                then: { required: ["distribution"] },
              },
              {
                if: { required: ["registry"], properties: { registry: { const: "npm" } } },
                // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
                then: {
                  properties: { verifiability: { enum: ["requires_fetch", "unverifiable"] } },
                },
              },
              {
                if: {
                  required: ["verifiability"],
                  properties: { verifiability: { const: "unverifiable" } },
                },
                // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
                then: { required: ["unverifiable_reason"] },
                else: { not: { required: ["unverifiable_reason"] } },
              },
            ],
          },
        },
        allOf: [
          {
            if: { required: ["kind"], properties: { kind: { const: "static_site" } } },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
            then: { required: ["content_manifest_digest"] },
            else: { not: { required: ["content_manifest_digest"] } },
          },
          {
            if: { required: ["kind"], properties: { kind: { const: "package" } } },
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
            then: { required: ["artifact_ref"] },
          },
        ],
      },
    },
    build: {
      type: "object",
      required: ["recipe_digest", "toolchain_digest"],
      additionalProperties: false,
      properties: {
        recipe_digest: { type: "string", pattern: SHA256_REF_PATTERN },
        recipe_ref: { type: "string", minLength: 1 },
        toolchain_digest: { type: "string", pattern: SHA256_REF_PATTERN },
        toolchain_ref: { type: "string", minLength: 1 },
      },
    },
    known_deviations: { type: "array", items: { type: "string", minLength: 1 } },
    rollback: {
      type: "object",
      required: ["previous_release_id"],
      additionalProperties: false,
      properties: {
        previous_release_id: { type: ["string", "null"], minLength: 1 },
      },
    },
    integrity: {
      type: "object",
      required: ["level", "signature"],
      additionalProperties: false,
      properties: {
        level: { enum: ["digest_only"] },
        signature: { type: "null" },
      },
    },
  },
  allOf: [
    {
      if: { required: ["lane_ref"], properties: { lane_ref: { type: "null" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { required: ["lane_ref_omitted"] },
      else: { not: { required: ["lane_ref_omitted"] } },
    },
    {
      if: { required: ["review"], properties: { review: { type: "null" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { required: ["review_omitted"] },
      else: { not: { required: ["review_omitted"] } },
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Hand mirror of the external release-evidence/v0 event schema
// (ai-agent-skills-playbook: contracts/release-evidence/v0/release-event.schema.json).
// ---------------------------------------------------------------------------

const RELEASE_EVENT_CONTENT_SCHEMA = {
  type: "object",
  required: [
    "schema_version",
    "event_id",
    "release_id",
    "kind",
    "environment",
    "occurred_at",
    "actor",
    "bundle_digest",
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: "release-evidence/v0" },
    event_id: { type: "string", minLength: 1 },
    release_id: { type: "string", minLength: 1 },
    kind: { enum: ["prepared", "deployed", "verified", "failed", "rolled_back", "attested"] },
    environment: {
      oneOf: [{ enum: ["preview", "staging", "production"] }, { type: "null" }],
    },
    occurred_at: { type: "string", pattern: TIMESTAMP_PATTERN },
    actor: { enum: ["human", "ci", "cli"] },
    bundle_digest: { type: "string", pattern: SHA256_REF_PATTERN },
    failure_phase: { enum: ["deploy", "verification", "post_verification"] },
    rollback_to_release_id: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    staging_skipped: { const: true },
    attestation: {
      type: "object",
      required: ["kind", "digest"],
      additionalProperties: false,
      properties: {
        kind: { enum: ["lane_done_overlay"] },
        digest: { type: "string", pattern: SHA256_REF_PATTERN },
        ref: { type: "string", minLength: 1 },
      },
    },
    notes: { type: "string", minLength: 1 },
    preview_skipped: { const: true },
    preview_skipped_code: { enum: ["no_preview_environment_scheduled_rebuild", "other"] },
  },
  allOf: [
    {
      if: { required: ["kind"], properties: { kind: { enum: ["prepared", "attested"] } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { properties: { environment: { type: "null" } } },
      else: { properties: { environment: { enum: ["preview", "staging", "production"] } } },
    },
    {
      if: { required: ["kind"], properties: { kind: { const: "failed" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { required: ["failure_phase", "reason"] },
      else: { not: { required: ["failure_phase"] } },
    },
    {
      if: { required: ["kind"], properties: { kind: { const: "rolled_back" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { required: ["rollback_to_release_id", "reason"] },
      else: { not: { required: ["rollback_to_release_id"] } },
    },
    {
      if: { required: ["kind"], properties: { kind: { const: "attested" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { required: ["attestation"] },
      else: { not: { required: ["attestation"] } },
    },
    {
      if: {
        required: ["kind"],
        properties: {
          kind: { enum: ["prepared", "verified", "attested", "rolled_back", "failed"] },
        },
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { not: { required: ["staging_skipped"] } },
    },
    {
      if: {
        required: ["kind"],
        properties: { kind: { enum: ["prepared", "deployed", "verified", "attested"] } },
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { not: { required: ["reason"] } },
    },
    {
      if: { required: ["preview_skipped"] },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { required: ["preview_skipped_code"], properties: { kind: { const: "deployed" } } },
      else: { not: { required: ["preview_skipped_code"] } },
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Hand mirror of the vendored review-findings/v1 schema
// (vendor/playbook-contracts/review-findings/v1/review-findings.schema.json) -- vendored in THIS
// repo, but still mirrored rather than loaded, for the fs-free reason this file's header explains.
// ---------------------------------------------------------------------------

const REVIEW_FINDING_RECORD_CONTENT_SCHEMA = {
  type: "object",
  required: [
    "schema_version",
    "record_id",
    "recorded_at",
    "supersedes_record_id",
    "subject",
    "scan_scope",
    "assessor",
    "outcome",
    "abstention",
    "findings",
  ],
  additionalProperties: false,
  properties: {
    schema_version: { const: "review-findings/v1" },
    record_id: { type: "string", minLength: 1 },
    recorded_at: { type: "string", pattern: TIMESTAMP_PATTERN },
    supersedes_record_id: { type: ["string", "null"], minLength: 1 },
    subject: {
      type: "object",
      required: ["repository_ref", "digest"],
      additionalProperties: false,
      properties: {
        repository_ref: { type: "string", minLength: 1, pattern: "^[^/\\s]+/[^/\\s]+$" },
        digest: { type: "string", pattern: SHA256_REF_PATTERN },
      },
    },
    scan_scope: {
      type: "object",
      required: ["paths", "commit_range", "lenses"],
      additionalProperties: false,
      properties: {
        paths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        commit_range: {
          type: "object",
          required: ["base", "head"],
          additionalProperties: false,
          properties: {
            base: { type: "string", pattern: HASH_HEX_PATTERN },
            head: { type: "string", pattern: HASH_HEX_PATTERN },
          },
        },
        lenses: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      },
    },
    assessor: {
      type: "object",
      required: ["kind", "model_cohort", "independence"],
      additionalProperties: false,
      properties: {
        kind: { enum: ["human", "model", "hybrid", "deterministic_tool"] },
        model_cohort: { type: ["string", "null"], minLength: 1 },
        independence: {
          type: "object",
          required: ["code", "params"],
          additionalProperties: false,
          properties: {
            code: { type: "string", minLength: 1 },
            params: { type: "object" },
          },
        },
      },
      allOf: [
        {
          if: {
            required: ["kind"],
            properties: { kind: { enum: ["human", "deterministic_tool"] } },
          },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
          then: { properties: { model_cohort: { type: "null" } } },
          else: { properties: { model_cohort: { type: "string", minLength: 1 } } },
        },
      ],
    },
    outcome: { enum: ["findings_observed", "none_observed_in_recorded_scope", "abstained"] },
    abstention: { type: ["object", "null"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: [
          "finding_id",
          "category",
          "severity",
          "claim",
          "locations",
          "suggested_fix",
          "evidence_gate",
        ],
        additionalProperties: false,
        properties: {
          finding_id: { type: "string", minLength: 1 },
          category: {
            enum: [
              "correctness",
              "security",
              "reliability",
              "performance",
              "type_safety",
              "test_quality",
              "maintainability",
              "documentation",
              "lint_format",
            ],
          },
          severity: { enum: ["critical", "high", "medium", "low"] },
          claim: { type: "string", minLength: 1 },
          locations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["path", "start_line", "end_line"],
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1 },
                start_line: { type: ["integer", "null"], minimum: 1 },
                end_line: { type: ["integer", "null"], minimum: 1 },
              },
            },
          },
          suggested_fix: { type: ["string", "null"], minLength: 1 },
          evidence_gate: {
            type: "object",
            required: ["oracle_kind", "oracle_ref", "predicate", "required_verdict"],
            additionalProperties: false,
            properties: {
              oracle_kind: { enum: ["external_outcome", "evigate"] },
              oracle_ref: { type: "string", minLength: 1 },
              predicate: {
                type: "object",
                required: ["code", "params"],
                additionalProperties: false,
                properties: {
                  code: { type: "string", minLength: 1 },
                  params: { type: "object" },
                },
              },
              required_verdict: { const: "proven" },
            },
          },
        },
      },
    },
  },
  allOf: [
    {
      if: { required: ["outcome"], properties: { outcome: { const: "findings_observed" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { properties: { findings: { minItems: 1 }, abstention: { type: "null" } } },
    },
    {
      if: {
        required: ["outcome"],
        properties: { outcome: { const: "none_observed_in_recorded_scope" } },
      },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: { properties: { findings: { maxItems: 0 }, abstention: { type: "null" } } },
    },
    {
      if: { required: ["outcome"], properties: { outcome: { const: "abstained" } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
      then: {
        properties: {
          findings: { maxItems: 0 },
          abstention: {
            type: "object",
            required: ["code", "params"],
            additionalProperties: false,
            properties: { code: { type: "string", minLength: 1 }, params: { type: "object" } },
          },
        },
      },
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// This evaluator's own draft schema for verification_record -- no external contract names one
// (sol's I/O pointer table says only that `lane_ref.verification_digest` must resolve to "the
// exact verification record", never what shape it has). Same draft-schema status as
// shadow-evaluation-input/v0.
// ---------------------------------------------------------------------------

const VERIFICATION_RECORD_CONTENT_SCHEMA_V0 = {
  type: "object",
  required: ["schema_version", "verification_id"],
  additionalProperties: false,
  properties: {
    schema_version: { const: "verification-record/v0" },
    verification_id: { type: "string", minLength: 1 },
  },
} as const;

// ---------------------------------------------------------------------------
// validateRecordContract
// ---------------------------------------------------------------------------

/** The kinds this file checks a content contract for. `selection_manifest` / `policy_snapshot` /
 * `other` carry no content contract this evaluator validates (spec.md non-goals) -- they pass
 * through resolver.ts untouched. */
type ContractedRecordKind =
  | "release_evidence_bundle"
  | "release_event"
  | "review_finding_record"
  | "verification_record";

const SUPPORTED_CONTENT_SCHEMA_VERSION: Record<ContractedRecordKind, string> = {
  release_evidence_bundle: "release-evidence/v0",
  release_event: "release-evidence/v0",
  review_finding_record: "review-findings/v1",
  verification_record: "verification-record/v0",
};

/** release_event's contractual time field is `occurred_at`; review_finding_record's is
 * `recorded_at`. Neither bundle nor verification_record has one (spec.md "no time axis"). */
const TIME_FIELD_BY_KIND: Partial<Record<ContractedRecordKind, "occurred_at" | "recorded_at">> = {
  release_event: "occurred_at",
  review_finding_record: "recorded_at",
};

function isContractedKind(kind: ExactRecordKind): kind is ContractedRecordKind {
  return kind in SUPPORTED_CONTENT_SCHEMA_VERSION;
}

function contentSchemaAndSemanticChecks(kind: ContractedRecordKind): {
  schema: object;
  semanticChecks: (record: ExactRecord) => string[];
} {
  switch (kind) {
    case "release_evidence_bundle":
      return {
        schema: RELEASE_EVIDENCE_BUNDLE_CONTENT_SCHEMA,
        semanticChecks: (record) => bundleContentSemanticChecks(record.content as Bundle),
      };
    case "release_event":
      return { schema: RELEASE_EVENT_CONTENT_SCHEMA, semanticChecks: requireObservedAtMatches };
    case "review_finding_record":
      return {
        schema: REVIEW_FINDING_RECORD_CONTENT_SCHEMA,
        semanticChecks: reviewFindingContentSemanticChecks,
      };
    case "verification_record":
      return { schema: VERIFICATION_RECORD_CONTENT_SCHEMA_V0, semanticChecks: () => [] };
  }
}

/** The release-evidence/v0 semantic MUST checks that RELEASE_EVIDENCE_BUNDLE_CONTENT_SCHEMA
 * alone cannot express (array sort/uniqueness is about ORDER, which JSON Schema has no keyword
 * for; hash-width consistency and rollback_to_self compare two sibling fields). A hand mirror of
 * `bundleSemanticChecks` in src/core/bundle.ts -- duplicated rather than imported because this
 * task's edit scope excludes src/core/**, and because src/core/bundle.ts's own `Bundle` import
 * there is fs-free already, so there is no fs-avoidance reason not to import it; the boundary is
 * purely "this round's stated file scope", recorded here so a future round can dedupe by
 * exporting and importing it once that scope opens up. */
function bundleContentSemanticChecks(bundle: Bundle): string[] {
  const reasons: string[] = [];

  const digests = bundle.artifacts.map((a) => a.digest);
  if (new Set(digests).size !== digests.length) {
    reasons.push(
      `artifacts_not_unique: duplicate artifact digest in release_id "${bundle.release_id}"`,
    );
  }
  const sortedDigests = [...digests].sort();
  if (digests.some((d, i) => d !== sortedDigests[i])) {
    reasons.push(
      "artifacts_not_sorted: artifacts[] must be sorted ascending by digest (array order is inside the JCS digest)",
    );
  }

  const deviations = bundle.known_deviations;
  if (new Set(deviations).size !== deviations.length) {
    reasons.push("deviations_not_unique: duplicate entry in known_deviations");
  }
  const sortedDeviations = [...deviations].sort();
  if (deviations.some((d, i) => d !== sortedDeviations[i])) {
    reasons.push("deviations_not_sorted: known_deviations must be sorted ascending");
  }

  if (bundle.source.commit_sha.length !== bundle.source.tree_digest.length) {
    reasons.push(
      "hash_width_mismatch: source.commit_sha and source.tree_digest have different widths -- one repository has one hash algorithm",
    );
  }

  if (bundle.rollback.previous_release_id === bundle.release_id) {
    reasons.push(
      "rollback_to_self: rollback.previous_release_id must differ from the bundle's own release_id",
    );
  }

  return reasons;
}

/** terra review must-3: "時間軸を持つ kind では observed_at を必須化し、契約上の occurred_at /
 * recorded_at と一致検証する" -- `record.observed_at` (the envelope's own claim about when this
 * record became visible) must be present AND byte-identical to the record's own contractual
 * timestamp field. Equal to a value that already passed TIMESTAMP_PATTERN + isRealTimestamp
 * (resolver.ts checks observed_at's realism before this function ever runs) transitively makes
 * the content field real too -- no separate realism check on the content field is needed. */
function requireObservedAtMatches(record: ExactRecord): string[] {
  const timeField = TIME_FIELD_BY_KIND[record.kind as ContractedRecordKind];
  if (!timeField) return [];
  if (record.observed_at === undefined) {
    return [`observed_at is required for kind "${record.kind}" (a time-bearing record)`];
  }
  const content = record.content as Record<string, unknown>;
  const contentValue = content[timeField];
  if (contentValue !== record.observed_at) {
    return [
      `observed_at "${record.observed_at}" does not match content.${timeField} ${JSON.stringify(contentValue)}`,
    ];
  }
  return [];
}

/** Hand-ported from vendored `review-findings/v1/verify-fixtures.mjs`'s `scanNumericConfidence`
 * (terra review round C, must-1 residual): R7 "SHALL NOT contain numeric confidence fields
 * anywhere" reaches into the open `{code, params}` dictionaries (`assessor.independence.params`,
 * `findings[].evidence_gate.predicate.params`) that `additionalProperties:false` cannot close off
 * because those bags are intentionally open. Matches any key whose lowercased name CONTAINS
 * "confidence" (sol architect should-4), not only an exact "confidence" key. Not vendored in
 * vendor/playbook-shared (the reference itself duplicates this identically into every contract's
 * own verify-fixtures.mjs rather than centralizing it), so this is a byte-for-byte-sourced copy,
 * not an import -- same discipline as `bundleContentSemanticChecks` above. */
function scanNumericConfidenceFields(value: unknown, pathStr = ""): string[] {
  const violations: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      violations.push(...scanNumericConfidenceFields(item, `${pathStr}[${i}]`)),
    );
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (key.toLowerCase().includes("confidence") && typeof val === "number")
        violations.push(here);
      violations.push(...scanNumericConfidenceFields(val, here));
    }
  }
  return violations;
}

/** Hand-ported from vendored `review-findings/v1/verify-fixtures.mjs`'s
 * `checkLocationConsistency` (terra review round C): `locations[].start_line`/`end_line` must be
 * both null or both non-null, and when both are recorded, `end_line >= start_line` -- a
 * cross-field relationship `type: ["integer","null"]` cannot express on its own. */
function checkLocationConsistency(findings: readonly Record<string, unknown>[]): string[] {
  const reasons: string[] = [];
  for (const f of findings) {
    const locations = Array.isArray(f.locations) ? (f.locations as Record<string, unknown>[]) : [];
    locations.forEach((loc, i) => {
      const startLine = loc.start_line;
      const endLine = loc.end_line;
      const bothNull = startLine === null && endLine === null;
      const bothSet = startLine !== null && endLine !== null;
      if (!bothNull && !bothSet) {
        reasons.push(
          `location_line_partial: finding "${f.finding_id}" locations[${i}] has only one of start_line/end_line recorded`,
        );
      } else if (bothSet && (endLine as number) < (startLine as number)) {
        reasons.push(
          `location_line_order: finding "${f.finding_id}" locations[${i}] end_line ${endLine} < start_line ${startLine}`,
        );
      }
    });
  }
  return dedupe(reasons);
}

/** review-findings/v1's semantic MUST the schema alone cannot express (terra review round C,
 * must-1 residual: "review-finding は schema＋時刻一致しか検証せず、reference が
 * duplicate_finding_id で reject する record でも review_admissibility=satisfied を再現しました" --
 * a hand mirror of vendored `review-findings/v1/verify-fixtures.mjs`'s own `checkRecord`, minus
 * the schema validation and recorded_at-realism checks this file's caller (`validateRecordContract`
 * / `requireObservedAtMatches` via `resolver.ts`'s pre-cut `isRealTimestamp` check) already does
 * elsewhere): personal-dimension scan, numeric-confidence scan, finding_id uniqueness, and
 * locations[] start/end-line consistency. */
function reviewFindingContentSemanticChecks(record: ExactRecord): string[] {
  const content = record.content;
  const reasons: string[] = [
    ...requireObservedAtMatches(record),
    ...scanPersonalDimensions(content).map((v) => `personal_dimension_forbidden_key: ${v}`),
    ...scanNumericConfidenceFields(content).map((v) => `numeric_confidence_forbidden_field: ${v}`),
  ];

  const findings = Array.isArray((content as Record<string, unknown>)?.findings)
    ? ((content as Record<string, unknown>).findings as Record<string, unknown>[])
    : [];
  const ids = findings.map((f) => f.finding_id);
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    reasons.push(`duplicate_finding_id: "${dup}" appears more than once in this record`);
  }
  reasons.push(...checkLocationConsistency(findings));

  return dedupe(reasons);
}

function schemaVersionOf(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null) return undefined;
  const value = (content as Record<string, unknown>).schema_version;
  return typeof value === "string" ? value : undefined;
}

/** Validates one record's CONTENT against its kind's contract (schema_version, full schema,
 * semantic MUST) -- called by resolver.ts for every digest-verified, non-future record BEFORE it
 * enters the resolved pool. Returns `null` when valid (or when `record.kind` names no content
 * contract this evaluator checks). Never returns a bare boolean/kind-only judgment (terra review
 * must-1: "kind一致だけでsatisfiedにしないでください"). */
export function validateRecordContract(record: ExactRecord): InputError | null {
  if (!isContractedKind(record.kind)) return null;
  const kind = record.kind;
  const expectedVersion = SUPPORTED_CONTENT_SCHEMA_VERSION[kind];

  const declaredVersion = schemaVersionOf(record.content);
  if (declaredVersion !== undefined && declaredVersion !== expectedVersion) {
    return inputError("unsupported_record_version", {
      kind,
      digest: record.digest,
      declared_schema_version: declaredVersion,
      supported_schema_version: expectedVersion,
    });
  }

  const { schema, semanticChecks } = contentSchemaAndSemanticChecks(kind);
  const schemaErrors = runSchema(schema, record.content);
  if (schemaErrors.length > 0) {
    return inputError("record_invalid", { kind, digest: record.digest, errors: schemaErrors });
  }

  const semanticErrors = semanticChecks(record);
  if (semanticErrors.length > 0) {
    return inputError("record_invalid", { kind, digest: record.digest, errors: semanticErrors });
  }

  return null;
}
