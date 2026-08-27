// CLI-level e2e test for the replay pack format (docs/replay-pack-format.md, chunk 3 spec.md test
// plan item 4). Enumerates every directory under test/fixtures/replay-packs/ -- never a hardcoded
// list -- and, for each, runs the real built CLI against its input.json and checks the result
// against its expected.json (a test-only expectations manifest, never part of the input the
// evaluator itself reads or schema-validates). At least a lane-backed (fully resolved) and a
// lane_ref_omitted pack are checked in under test/fixtures/replay-packs/ today (chunk 3's own
// minimum); this test does not know or care how many there are beyond "whatever readdirSync
// finds", so a future pack needs no test-code change to be covered.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { validateBundle } from "../src/core/bundle.js";
import { validateEvent } from "../src/core/event.js";
import { checkReviewFindingAgainstVendoredVerifier } from "../src/shadow-cli/vendor-loader.js";
import type { ExactRecord, ShadowEvaluation, ShadowEvaluationInput } from "../src/shadow/input.js";
import { HAS_CONTRACTS_DIR } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "shadow-cli", "main.js");
const PACKS_DIR = path.join(REPO_ROOT, "test", "fixtures", "replay-packs");

interface ExpectedPredicate {
  predicate_id: string;
  applicability: string;
  status: string;
  reason_code?: string;
}

interface ExpectedResult {
  evaluation_status: string;
  verdict: string | null;
  predicate_observations: ExpectedPredicate[];
}

function listPackDirs(): string[] {
  return readdirSync(PACKS_DIR).filter((name) =>
    statSync(path.join(PACKS_DIR, name)).isDirectory(),
  );
}

describe("replay pack format: CLI end-to-end (docs/replay-pack-format.md)", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  });

  const packNames = listPackDirs();

  it("at least the lane-backed and lane-ref-omitted packs are present (chunk 3's stated minimum)", () => {
    expect(packNames).toEqual(expect.arrayContaining(["lane-backed", "lane-ref-omitted"]));
  });

  it.each(packNames)("pack %s: input.json and README.md are present", (name) => {
    const dir = path.join(PACKS_DIR, name);
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(["input.json", "README.md"]));
  });

  // terra review must-7 (2026-08-27): a pack's expected.json must not fix the "right answer" as
  // whatever this evaluator's own (deliberately shallow, contracts.ts) content checks happen to
  // accept -- every contract-bearing record in input.json is checked here against its OWN
  // contract's reference validator (release-evidence/v0's validateBundle/validateEvent, review-
  // findings/v1's vendored checkRecord) BEFORE the CLI e2e comparison below trusts expected.json
  // as ground truth. verification_record/selection_manifest/policy_snapshot/other carry no
  // external reference contract this evaluator checks (this evaluator's own draft schema, or a
  // documented non-goal -- see input.ts/contracts.ts) and are skipped here, same as everywhere
  // else in this repo. bundle/event validation needs RELEASE_EVIDENCE_CONTRACTS_DIR -- skipped
  // with the same it.skipIf convention as every other schema-backed test when it isn't set
  // (helpers.ts already warns once at import time; this is not a new silent cap).
  it.each(packNames)(
    "pack %s: every contract-bearing record in input.json is valid per its OWN reference validator",
    async (name) => {
      const dir = path.join(PACKS_DIR, name);
      const input = JSON.parse(
        readFileSync(path.join(dir, "input.json"), "utf-8"),
      ) as ShadowEvaluationInput;
      for (const record of input.records as ExactRecord[]) {
        if (record.kind === "release_evidence_bundle") {
          if (!HAS_CONTRACTS_DIR) continue;
          expect(validateBundle(record.content)).toEqual([]);
        } else if (record.kind === "release_event") {
          if (!HAS_CONTRACTS_DIR) continue;
          expect(validateEvent(record.content)).toEqual([]);
        } else if (record.kind === "review_finding_record") {
          expect(await checkReviewFindingAgainstVendoredVerifier(record.content)).toEqual([]);
        }
      }
    },
  );

  it.each(packNames)("pack %s: replay exits 0 and matches expected.json", (name) => {
    const dir = path.join(PACKS_DIR, name);
    const inputPath = path.join(dir, "input.json");
    const expectedPath = path.join(dir, "expected.json");

    const outDir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-replay-pack-"));
    const outPath = path.join(outDir, "out.json");
    execFileSync(process.execPath, [CLI, "replay", "--input", inputPath, "--out", outPath], {
      encoding: "utf-8",
    });

    const evaluation = JSON.parse(readFileSync(outPath, "utf-8")) as ShadowEvaluation;
    const expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as ExpectedResult;

    expect(evaluation.evaluation_status).toBe(expected.evaluation_status);
    expect(evaluation.candidate_receipt?.verdict ?? null).toBe(expected.verdict);

    const actualById = new Map(evaluation.predicate_observations.map((o) => [o.predicate_id, o]));
    for (const exp of expected.predicate_observations) {
      const actual = actualById.get(
        exp.predicate_id as ShadowEvaluation["predicate_observations"][number]["predicate_id"],
      );
      expect(actual, `predicate ${exp.predicate_id} missing from replay output`).toBeDefined();
      expect(actual?.applicability).toBe(exp.applicability);
      expect(actual?.status).toBe(exp.status);
      if (exp.reason_code) {
        expect(actual?.reason?.code).toBe(exp.reason_code);
      }
    }
  });
});
