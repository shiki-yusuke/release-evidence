// CLI-level exit-code contract for `release-evidence-shadow replay` (spec.md "live 化の構造的
//防止": verdict never causes a non-zero exit; only malformed input / tool failure does). Runs
// the built dist/src/shadow-cli/main.js as a real subprocess, same style as test/cli.test.ts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExactRecord, ShadowEvaluation, ShadowEvaluationInput } from "../src/shadow/input.js";
import { recordContentDigest } from "../src/shadow/serialize.js";
import {
  validBundleContent,
  validEventContent,
  validReviewFindingContent,
  validVerificationRecordContent,
} from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "shadow-cli", "main.js");

function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf-8",
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
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
const BUNDLE_CONTENT = validBundleContent({
  release_id: RELEASE_ID,
  lane_ref: { verification_digest: VERIFICATION_DIGEST },
  review: { decision: "approved" },
  rollback_previous_release_id: null,
});

function fullyResolvedInput(): ShadowEvaluationInput {
  const manifest = record("selection_manifest", { manifest_id: "sm-1" });
  const bundle = record("release_evidence_bundle", BUNDLE_CONTENT);
  const verification = record("verification_record", VERIFICATION_CONTENT);
  const reviewFinding = record(
    "review_finding_record",
    validReviewFindingContent({ record_id: "rf-1", recorded_at: EVALUATION_CUT }),
    EVALUATION_CUT,
  );
  // round C: a LEGAL release lifecycle (prepared -> deployed|preview -> verified|preview) --
  // a lone verified/preview event with no preceding prepared/deployed folds illegally through
  // the D5 transition graph and is never trusted as satisfied evidence (see
  // src/shadow/evaluate.ts's foldAttemptEvents).
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
  };
}

/** Recursively reverses every plain object's own key insertion order (arrays are left in element
 * order -- only object KEYS are reordered, matching what JCS canonicalization is specifically
 * indifferent to; array order stays meaningful and is exercised by the separate records-order
 * test below). Used to prove the CLI's output is byte-identical regardless of the input JSON
 * text's object key order. */
function reverseKeyOrderDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeyOrderDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).reverse()) {
      out[k] = reverseKeyOrderDeep(v);
    }
    return out;
  }
  return value;
}

function writeInput(dir: string, input: unknown): string {
  const inputPath = path.join(dir, "input.json");
  writeFileSync(inputPath, JSON.stringify(input));
  return inputPath;
}

describe("release-evidence-shadow CLI", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  });

  it("replay on a fully-resolvable input exits 0 and prints a shadow-evaluation/v0 (even though the verdict is abstained, not ready_for_approval)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const inputPath = writeInput(dir, fullyResolvedInput());
    const result = runCli(["replay", "--input", inputPath]);
    expect(result.status).toBe(0);
    const evaluation = JSON.parse(result.stdout) as ShadowEvaluation;
    expect(evaluation.evaluation_status).toBe("evaluated");
    expect(evaluation.candidate_receipt?.verdict).toBe("abstained");
  });

  it("replay writes to --out when given, and stdout stays empty", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const inputPath = writeInput(dir, fullyResolvedInput());
    const outPath = path.join(dir, "out.json");
    const result = runCli(["replay", "--input", inputPath, "--out", outPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const written = JSON.parse(readFileSync(outPath, "utf-8")) as ShadowEvaluation;
    expect(written.evaluation_status).toBe("evaluated");
  });

  it("replay on an unresolvable selection_manifest exits 0 (evaluation_status=unknown is a legitimate recorded outcome, not malformed input)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const input = fullyResolvedInput();
    input.subject.selection_manifest_digest = SHA("missing");
    const inputPath = writeInput(dir, input);
    const result = runCli(["replay", "--input", inputPath]);
    expect(result.status).toBe(0);
    const evaluation = JSON.parse(result.stdout) as ShadowEvaluation;
    expect(evaluation.evaluation_status).toBe("unknown");
    expect(evaluation.candidate_receipt).toBeNull();
  });

  it("replay on schema-invalid input (missing required field) exits non-zero", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const input = fullyResolvedInput() as Partial<ShadowEvaluationInput>;
    // biome-ignore lint/performance/noDelete: `required` is checked via `in`, so undefined !== missing
    delete input.evaluation_cut;
    const inputPath = writeInput(dir, input);
    const result = runCli(["replay", "--input", inputPath]);
    expect(result.status).not.toBe(0);
  });

  it("replay on a tampered exact record (digest mismatch) exits non-zero (invalid_input is malformed input)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const input = fullyResolvedInput();
    const tamperedBundleIdx = input.records.findIndex((r) => r.kind === "release_evidence_bundle");
    const original = input.records[tamperedBundleIdx];
    if (!original) throw new Error("fixture bug: no release_evidence_bundle record");
    input.records[tamperedBundleIdx] = {
      ...original,
      content: { ...BUNDLE_CONTENT, release_id: "tampered" },
    };
    const inputPath = writeInput(dir, input);
    const result = runCli(["replay", "--input", inputPath]);
    expect(result.status).not.toBe(0);
  });

  it("replay on an unreadable --input file exits non-zero", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const result = runCli(["replay", "--input", path.join(dir, "does-not-exist.json")]);
    expect(result.status).not.toBe(0);
  });

  it("an unknown flag exits non-zero", () => {
    const result = runCli(["replay", "--nonsense", "x"]);
    expect(result.status).not.toBe(0);
  });

  it("an unknown command exits non-zero", () => {
    const result = runCli(["enforce"]);
    expect(result.status).not.toBe(0);
  });

  it("an extra positional argument after the command exits non-zero (nit: terra review -- 'replay extra --input ...' is a usage error, not silently ignored)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const inputPath = writeInput(dir, fullyResolvedInput());
    const result = runCli(["replay", "extra", "--input", inputPath]);
    expect(result.status).not.toBe(0);
  });

  it("two independent process runs on the same input produce byte-identical stdout (determinism, spec.md '2 process byte comparison')", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const inputPath = writeInput(dir, fullyResolvedInput());
    const first = runCli(["replay", "--input", inputPath]);
    const second = runCli(["replay", "--input", inputPath]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.endsWith("\n")).toBe(true);
  });

  it("TZ=UTC vs TZ=Asia/Tokyo produce byte-identical stdout (two separate processes, spec.md '決定論': no ambient clock read)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const inputPath = writeInput(dir, fullyResolvedInput());
    const utc = runCli(["replay", "--input", inputPath], { TZ: "UTC" });
    const tokyo = runCli(["replay", "--input", inputPath], { TZ: "Asia/Tokyo" });
    expect(utc.status).toBe(0);
    expect(tokyo.status).toBe(0);
    expect(utc.stdout).toBe(tokyo.stdout);
  });

  it("LC_ALL=C vs LC_ALL=ja_JP.UTF-8 produce byte-identical stdout (two separate processes -- sort order below uses plain string comparison, never localeCompare)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const inputPath = writeInput(dir, fullyResolvedInput());
    const cLocale = runCli(["replay", "--input", inputPath], { LC_ALL: "C" });
    const jaLocale = runCli(["replay", "--input", inputPath], { LC_ALL: "ja_JP.UTF-8" });
    expect(cLocale.status).toBe(0);
    expect(jaLocale.status).toBe(0);
    expect(cLocale.stdout).toBe(jaLocale.stdout);
  });

  it("input JSON with every object's key order reversed produces byte-identical stdout (two separate processes -- JCS canonicalizes object keys, never trusts input order)", () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const original = fullyResolvedInput();
    const keyReordered = reverseKeyOrderDeep(original) as ShadowEvaluationInput;
    const pathA = writeInput(dirA, original);
    const pathB = writeInput(dirB, keyReordered);
    // Guard the premise: the two files' bytes must actually differ (same value, different key
    // order), or this test would trivially pass without exercising canonicalization at all.
    expect(readFileSync(pathA, "utf-8")).not.toBe(readFileSync(pathB, "utf-8"));
    const first = runCli(["replay", "--input", pathA]);
    const second = runCli(["replay", "--input", pathB]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("input.records array order reversed produces byte-identical stdout (two separate processes -- input_manifest.records is sorted by (kind, digest), never left in arrival order)", () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const original = fullyResolvedInput();
    const reversedRecords = { ...original, records: [...original.records].reverse() };
    const pathA = writeInput(dirA, original);
    const pathB = writeInput(dirB, reversedRecords);
    const first = runCli(["replay", "--input", pathA]);
    const second = runCli(["replay", "--input", pathB]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });

  it("a duplicate-digest kind collision produces byte-identical (invalid_input) stdout regardless of records array order (two separate processes, terra review must-4)", () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const original = fullyResolvedInput();
    // Two envelopes wrapping the SAME content (so they share one digest) under different `kind`
    // labels -- before must-4's fix, resolver.ts's plain `Map.set` last-write-wins meant whichever
    // envelope came later in the array silently won, flipping which kind a pointer resolved to.
    const collidingContent = { collision_marker: "must-4" };
    const collidingDigest = recordContentDigest(collidingContent);
    const asOther: ExactRecord = {
      kind: "other",
      digest: collidingDigest,
      content: collidingContent,
    };
    const asPolicySnapshot: ExactRecord = {
      kind: "policy_snapshot",
      digest: collidingDigest,
      content: collidingContent,
    };
    const forwardOrder = { ...original, records: [...original.records, asOther, asPolicySnapshot] };
    const reversedOrder = {
      ...original,
      records: [...original.records, asPolicySnapshot, asOther],
    };
    const pathA = writeInput(dirA, forwardOrder);
    const pathB = writeInput(dirB, reversedOrder);
    const first = runCli(["replay", "--input", pathA]);
    const second = runCli(["replay", "--input", pathB]);
    expect(first.status).not.toBe(0);
    expect(second.status).not.toBe(0);
    expect(first.stdout).toBe(second.stdout);
    const evaluation = JSON.parse(first.stdout) as ShadowEvaluation;
    expect(evaluation.evaluation_status).toBe("invalid_input");
  });

  it("two INDEPENDENT invalid records (unrelated kinds/digests) produce byte-identical (invalid_input) stdout regardless of which one comes first (two separate processes, terra review round C: input_errors must sort deterministically, not accumulate in array-arrival order)", () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "release-evidence-shadow-cli-"));
    const original = fullyResolvedInput();
    const brokenEvent = record("release_event", { broken: "event" });
    const brokenVerification = record("verification_record", { broken: "verification" });
    const forwardOrder = {
      ...original,
      records: [...original.records, brokenEvent, brokenVerification],
    };
    const reversedOrder = {
      ...original,
      records: [...original.records, brokenVerification, brokenEvent],
    };
    const pathA = writeInput(dirA, forwardOrder);
    const pathB = writeInput(dirB, reversedOrder);
    const first = runCli(["replay", "--input", pathA]);
    const second = runCli(["replay", "--input", pathB]);
    expect(first.status).not.toBe(0);
    expect(second.status).not.toBe(0);
    expect(first.stdout).toBe(second.stdout);
    const evaluation = JSON.parse(first.stdout) as ShadowEvaluation;
    expect(evaluation.evaluation_status).toBe("invalid_input");
    expect(evaluation.input_errors).toHaveLength(2);
  });
});
