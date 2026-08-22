import { describe, expect, it } from "vitest";
import { bundleDigest, validateBundle } from "../src/core/bundle.js";
import type { Bundle } from "../src/core/types.js";
import { HAS_CONTRACTS_DIR } from "./helpers.js";

const VALID_BUNDLE: Bundle = {
  schema_version: "release-evidence/v0",
  release_id: "demo@1.0.0",
  source: {
    repo: "example/demo",
    commit_sha: "1111111111111111111111111111111111111111",
    tree_digest: "2222222222222222222222222222222222222222",
    resolution: "git_tree",
  },
  lane_ref: null,
  lane_ref_omitted: { code: "legacy_release_predates_contract", note: "predates the contract" },
  review: null,
  review_omitted: { code: "legacy_release_predates_contract", note: "predates the contract" },
  artifacts: [
    {
      kind: "package",
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      artifact_ref: {
        registry: "other",
        package: "demo",
        version: "1.0.0",
        verifiability: "registry_metadata",
      },
    },
  ],
  build: {
    recipe_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    toolchain_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  },
  known_deviations: [],
  rollback: { previous_release_id: null },
  integrity: { level: "digest_only", signature: null },
};

describe("bundleDigest", () => {
  it("is stable regardless of key insertion order (JCS canonicalizes keys)", () => {
    const reordered = JSON.parse(JSON.stringify(VALID_BUNDLE));
    const rebuilt: Record<string, unknown> = {};
    for (const key of Object.keys(reordered).sort().reverse()) rebuilt[key] = reordered[key];

    expect(bundleDigest(rebuilt)).toBe(bundleDigest(VALID_BUNDLE));
  });

  it("changes when any field changes -- a new tree is a new attempt", () => {
    const changed: Bundle = {
      ...VALID_BUNDLE,
      known_deviations: ["something noticed at seal time"],
    };
    expect(bundleDigest(changed)).not.toBe(bundleDigest(VALID_BUNDLE));
  });
});

describe.skipIf(!HAS_CONTRACTS_DIR)("validateBundle", () => {
  it("accepts a well-formed bundle", () => {
    expect(validateBundle(VALID_BUNDLE)).toEqual([]);
  });

  it("rejects unsorted artifacts (semantic check beyond the schema)", () => {
    const bundle: Bundle = {
      ...VALID_BUNDLE,
      artifacts: [
        {
          kind: "package",
          digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
          artifact_ref: {
            registry: "other",
            package: "demo",
            version: "1.0.0",
            verifiability: "registry_metadata",
          },
        },
        {
          kind: "package",
          digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          artifact_ref: {
            registry: "other",
            package: "demo2",
            version: "1.0.0",
            verifiability: "registry_metadata",
          },
        },
      ],
    };
    expect(validateBundle(bundle).some((r) => r.startsWith("artifacts_not_sorted:"))).toBe(true);
  });

  it("rejects a rollback pointer to the bundle's own release_id", () => {
    const bundle: Bundle = {
      ...VALID_BUNDLE,
      rollback: { previous_release_id: VALID_BUNDLE.release_id },
    };
    expect(validateBundle(bundle).some((r) => r.startsWith("rollback_to_self:"))).toBe(true);
  });

  it("rejects mismatched commit_sha/tree_digest hash widths", () => {
    const bundle: Bundle = {
      ...VALID_BUNDLE,
      source: { ...VALID_BUNDLE.source, tree_digest: "2".repeat(64) }, // 64 hex vs commit_sha's 40
    };
    expect(validateBundle(bundle).some((r) => r.startsWith("hash_width_mismatch:"))).toBe(true);
  });
});
