// Shared test helpers. RELEASE_EVIDENCE_CONTRACTS_DIR must point at the release-evidence/v0
// contracts directory in ai-agent-skills-playbook; any test that calls into schema validation
// (validateBundle/validateEvent, and anything built on top of them) needs it, and is skipped
// with an explicit message when it is not set rather than failing opaquely.

export const CONTRACTS_DIR = process.env.RELEASE_EVIDENCE_CONTRACTS_DIR;
export const HAS_CONTRACTS_DIR = Boolean(CONTRACTS_DIR);

if (!HAS_CONTRACTS_DIR) {
  console.warn(
    "RELEASE_EVIDENCE_CONTRACTS_DIR is not set -- schema-backed tests (bundle/event/ledger/conformance) will be skipped. " +
      "Set it to the release-evidence/v0 contracts dir in ai-agent-skills-playbook to run them.",
  );
}

// ---------------------------------------------------------------------------
// shadow/** fixture builders: since terra review must-1 (2026-08-27), src/shadow/contracts.ts
// validates bundle/release_event/review_finding_record/verification_record CONTENT against a
// full in-memory mirror of the real contract schema (release-evidence/v0's bundle+event, the
// vendored review-findings/v1, and this evaluator's own verification-record/v0 draft) -- these
// builders produce genuinely contract-valid content so shadow/** tests exercise real predicate
// logic instead of tripping the new validation layer's required-field checks by accident.
// ---------------------------------------------------------------------------

const HASH40 = (label: string) => label.repeat(40).slice(0, 40);
const SHA256 = (label: string) => `sha256:${label.repeat(64).slice(0, 64)}`;

export function validBundleContent(
  opts: {
    release_id?: string;
    lane_ref?: { verification_digest: string } | null;
    lane_ref_omitted_code?:
      | "no_lane_scheduled_rebuild"
      | "multiple_contributing_lanes"
      | "legacy_release_predates_contract"
      | "other";
    review?: {
      decision: "approved" | "commented" | "self_merged";
      pr?: number;
      head_sha?: string;
    } | null;
    review_omitted_code?:
      | "scheduled_rebuild_deploys_reviewed_main"
      | "legacy_release_predates_contract"
      | "other";
    rollback_previous_release_id?: string | null;
  } = {},
): Record<string, unknown> {
  const laneRef = opts.lane_ref ?? null;
  const review = opts.review ?? null;
  return {
    schema_version: "release-evidence/v0",
    release_id: opts.release_id ?? "spec-lane@0.7.0",
    source: {
      repo: "shiki-yusuke/spec-lane",
      commit_sha: HASH40("b"),
      tree_digest: HASH40("c"),
      resolution: "git_tree",
    },
    lane_ref: laneRef
      ? {
          lane_id: "lane-1",
          intent_digest: SHA256("1"),
          spec_digest: SHA256("2"),
          consensus_ack_digest: SHA256("3"),
          verification_digest: laneRef.verification_digest,
        }
      : null,
    ...(laneRef
      ? {}
      : {
          lane_ref_omitted: { code: opts.lane_ref_omitted_code ?? "other", note: "test fixture" },
        }),
    review: review
      ? { pr: review.pr ?? 1, head_sha: review.head_sha ?? HASH40("d"), decision: review.decision }
      : null,
    ...(review
      ? {}
      : { review_omitted: { code: opts.review_omitted_code ?? "other", note: "test fixture" } }),
    artifacts: [
      {
        kind: "package",
        digest: SHA256("a"),
        artifact_ref: {
          registry: "npm",
          package: "@shiki-yusuke/spec-lane",
          version: "0.7.0",
          verifiability: "requires_fetch",
        },
      },
    ],
    build: { recipe_digest: SHA256("b"), toolchain_digest: SHA256("c") },
    known_deviations: [],
    rollback: { previous_release_id: opts.rollback_previous_release_id ?? null },
    integrity: { level: "digest_only", signature: null },
  };
}

export function validEventContent(fields: {
  release_id: string;
  kind: "prepared" | "deployed" | "verified" | "failed" | "rolled_back" | "attested";
  environment: "preview" | "staging" | "production" | null;
  bundle_digest: string;
  occurred_at: string;
  event_id?: string;
  actor?: "human" | "ci" | "cli";
  failure_phase?: "deploy" | "verification" | "post_verification";
  rollback_to_release_id?: string;
  reason?: string;
  preview_skipped?: true;
  preview_skipped_code?: "no_preview_environment_scheduled_rebuild" | "other";
}): Record<string, unknown> {
  return {
    schema_version: "release-evidence/v0",
    event_id:
      fields.event_id ?? `evt-${fields.release_id}-${fields.kind}-${fields.environment ?? "none"}`,
    release_id: fields.release_id,
    kind: fields.kind,
    environment: fields.environment,
    occurred_at: fields.occurred_at,
    actor: fields.actor ?? "ci",
    bundle_digest: fields.bundle_digest,
    ...(fields.failure_phase !== undefined ? { failure_phase: fields.failure_phase } : {}),
    ...(fields.rollback_to_release_id !== undefined
      ? { rollback_to_release_id: fields.rollback_to_release_id }
      : {}),
    ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    ...(fields.preview_skipped
      ? {
          preview_skipped: true as const,
          preview_skipped_code: fields.preview_skipped_code ?? "other",
        }
      : {}),
  };
}

export function validReviewFindingContent(opts: {
  record_id: string;
  recorded_at: string;
  repository_ref?: string;
  digest?: string;
}): Record<string, unknown> {
  return {
    schema_version: "review-findings/v1",
    record_id: opts.record_id,
    recorded_at: opts.recorded_at,
    supersedes_record_id: null,
    subject: {
      repository_ref: opts.repository_ref ?? "shiki-yusuke/spec-lane",
      digest: opts.digest ?? SHA256("9"),
    },
    scan_scope: {
      paths: ["**/*"],
      commit_range: { base: HASH40("b"), head: HASH40("c") },
      lenses: ["correctness"],
    },
    assessor: {
      kind: "deterministic_tool",
      model_cohort: null,
      independence: { code: "different_provider", params: {} },
    },
    outcome: "none_observed_in_recorded_scope",
    abstention: null,
    findings: [],
  };
}

export function validVerificationRecordContent(verification_id: string): Record<string, unknown> {
  return { schema_version: "verification-record/v0", verification_id };
}
