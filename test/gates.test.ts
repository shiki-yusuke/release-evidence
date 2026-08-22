import { describe, expect, it } from "vitest";
import { checkProductionGate } from "../src/core/gates.js";
import type { Bundle, ReleaseEvent } from "../src/core/types.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function laneBackedBundle(): Bundle {
  return {
    schema_version: "release-evidence/v0",
    release_id: "demo@1.0.0",
    source: {
      repo: "example/demo",
      commit_sha: "1111111111111111111111111111111111111111",
      tree_digest: "2222222222222222222222222222222222222222",
      resolution: "git_tree",
    },
    lane_ref: {
      lane_id: "lane-1",
      intent_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      spec_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      consensus_ack_digest:
        "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      verification_digest:
        "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    },
    review: null,
    review_omitted: { code: "legacy_release_predates_contract", note: "n/a" },
    artifacts: [
      {
        kind: "package",
        digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        artifact_ref: {
          registry: "other",
          package: "demo",
          version: "1.0.0",
          verifiability: "registry_metadata",
        },
      },
    ],
    build: {
      recipe_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      toolchain_digest: "sha256:7777777777777777777777777777777777777777777777777777777777777777",
    },
    known_deviations: [],
    rollback: { previous_release_id: null },
    integrity: { level: "digest_only", signature: null },
  };
}

function attested(digest = DIGEST): ReleaseEvent {
  return {
    schema_version: "release-evidence/v0",
    event_id: "attest-1",
    release_id: "demo@1.0.0",
    kind: "attested",
    environment: null,
    occurred_at: "2026-08-22T00:00:00Z",
    actor: "ci",
    bundle_digest: digest,
    attestation: {
      kind: "lane_done_overlay",
      digest: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
    },
  };
}

describe("checkProductionGate", () => {
  it("blocks a lane-backed bundle with no prior lane_done_overlay attestation", () => {
    const problems = checkProductionGate(laneBackedBundle(), []);
    expect(problems.some((p) => p.startsWith("production_gate_missing_done_attestation:"))).toBe(
      true,
    );
  });

  it("passes a lane-backed bundle once a lane_done_overlay attestation is present", () => {
    const problems = checkProductionGate(laneBackedBundle(), [attested()]);
    expect(problems).toEqual([]);
  });

  it("blocks review.decision === 'commented'", () => {
    const bundle: Bundle = {
      ...laneBackedBundle(),
      review: { pr: 1, head_sha: "a".repeat(40), decision: "commented" },
    };
    const problems = checkProductionGate(bundle, [attested()]);
    expect(problems.some((p) => p.startsWith("production_gate_review_not_passed:"))).toBe(true);
  });

  it("passes a laneless bundle with no attestation required", () => {
    const bundle: Bundle = {
      ...laneBackedBundle(),
      lane_ref: null,
      lane_ref_omitted: { code: "no_lane_scheduled_rebuild", note: "n/a" },
    };
    expect(checkProductionGate(bundle, [])).toEqual([]);
  });
});
