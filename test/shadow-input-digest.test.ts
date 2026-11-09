// input_digest on the shadow-evaluation/v0 wrapper (F3 phase 2 Part A; design
// cognitive-debt-metrics-v0 §1 評価ペア束縛): `"sha256:" + hex(sha256(JCS(input)))` where input is
// `JSON.parse(input.json bytes)`. A harvester recomputes it from the committed input.json and binds
// the pair. Spec A6 test map:
//   (1)  matches an independent JCS sha256 of JSON.parse(input bytes), one case per evaluation_status
//   (2)  changing any one input field changes input_digest AND record_digest
//   (3)  key order / whitespace in the input bytes never changes input_digest
//   (3b) reversing records[] DOES change input_digest (JCS preserves array order -- an
//        implementation that sorts / normalizes records before hashing fails here)
//   (4)  SHADOW_EVALUATION_SCHEMA_V0 rejects a missing / malformed input_digest
//   (5)  cmdReplay's self-verification (spec A4) fails closed with a tool failure (exit 2)
// Plus spec A3: candidate_receipt bytes and receipt_id are pinned to the values produced BEFORE
// input_digest existed (base 213c2d1), so receipt identity provably did not move.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "#vendor/jcs.mjs";
import { evaluate } from "../src/shadow/evaluate.js";
import type { ShadowEvaluation, ShadowEvaluationInput } from "../src/shadow/input.js";
import { validateShadowEvaluation } from "../src/shadow/input.js";
import { computeRecordDigest } from "../src/shadow/serialize.js";
import { verifyInputDigest, verifyRecordDigest } from "../src/shadow/verify.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "shadow-cli", "main.js");
const PACKS_DIR = path.join(REPO_ROOT, "test", "fixtures", "replay-packs");
const LANE_BACKED = path.join(PACKS_DIR, "lane-backed", "input.json");

const UNRESOLVABLE = `sha256:${"0".repeat(64)}`;

// Independent of serialize.ts's sha256hex: node:crypto over the vendored JCS bytes.
function jcsDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf-8").digest("hex")}`;
}

function loadInput(file = LANE_BACKED): ShadowEvaluationInput {
  return JSON.parse(readFileSync(file, "utf-8")) as ShadowEvaluationInput;
}

/** status "unknown": selection_manifest_digest resolves to nothing in the pool. */
function unknownInput(): ShadowEvaluationInput {
  const input = loadInput();
  input.subject.selection_manifest_digest = UNRESOLVABLE;
  return input;
}

/** status "invalid_input": one record's declared digest no longer matches its content. */
function invalidInput(): ShadowEvaluationInput {
  const input = loadInput();
  const first = input.records[0];
  if (!first) throw new Error("fixture has no records");
  first.digest = UNRESOLVABLE;
  return input;
}

/** Recursively reverses object key order -- JCS must make this irrelevant. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

function runReplay(inputBytes: string): {
  status: number;
  inputPath: string;
  evaluation: ShadowEvaluation;
  outBytes: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "shadow-input-digest-"));
  const inputPath = path.join(dir, "input.json");
  const outPath = path.join(dir, "evaluation.json");
  writeFileSync(inputPath, inputBytes);
  let status = 0;
  try {
    execFileSync(process.execPath, [CLI, "replay", "--input", inputPath, "--out", outPath], {
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err) {
    status = (err as { status: number }).status;
  }
  const outBytes = readFileSync(outPath, "utf-8");
  return { status, inputPath, evaluation: JSON.parse(outBytes) as ShadowEvaluation, outBytes };
}

describe("input_digest (1): equals JCS sha256 of JSON.parse(input bytes), every evaluation_status", () => {
  const cases: Array<[string, () => ShadowEvaluationInput, number]> = [
    ["evaluated", loadInput, 0],
    ["unknown", unknownInput, 0],
    ["invalid_input", invalidInput, 2],
  ];

  it.each(cases)("CLI replay, status %s", (status, build, exitCode) => {
    // Non-canonical source bytes (indent 3) so "JSON.parse(input bytes)" is genuinely exercised.
    const run = runReplay(JSON.stringify(build(), null, 3));
    expect(run.status).toBe(exitCode);
    expect(run.evaluation.evaluation_status).toBe(status);
    const parsed = JSON.parse(readFileSync(run.inputPath, "utf-8"));
    expect(run.evaluation.input_digest).toBe(jcsDigest(parsed));
    expect(validateShadowEvaluation(run.evaluation)).toEqual([]);
    expect(verifyRecordDigest(run.evaluation)).toBe(true);
  });

  it.each(cases)("evaluate() in-process, status %s", (status, build) => {
    const input = build();
    const evaluation = evaluate(input);
    expect(evaluation.evaluation_status).toBe(status);
    expect(evaluation.input_digest).toBe(jcsDigest(input));
  });

  it("record_digest covers input_digest (spec A2): stripping input_digest changes the self-digest", () => {
    const evaluation = evaluate(loadInput());
    const { input_digest: _drop, ...withoutInputDigest } = evaluation;
    expect(computeRecordDigest(withoutInputDigest)).not.toBe(evaluation.record_digest);
    expect(verifyRecordDigest(evaluation)).toBe(true);
  });
});

describe("input_digest (2): any one-field input change moves input_digest and record_digest", () => {
  const base = evaluate(loadInput());

  const mutations: Array<[string, (i: ShadowEvaluationInput) => void]> = [
    // Does not affect the evaluation itself -- so record_digest moving proves it is input_digest
    // (not some other wrapper field) that changed the self-digest.
    [
      "policy.absent_reason.note (evaluation-irrelevant)",
      (i) => {
        (i.policy as unknown as { absent_reason: { note: string } }).absent_reason.note += " ";
      },
    ],
    [
      "subject.target",
      (i) => {
        i.subject.target = "preview";
      },
    ],
    [
      "evaluation_cut",
      (i) => {
        i.evaluation_cut = "2026-08-30T00:00:00Z";
      },
    ],
  ];

  it.each(mutations)("%s", (label, mutate) => {
    const input = loadInput();
    mutate(input);
    const changed = evaluate(input);
    expect(changed.input_digest).not.toBe(base.input_digest);
    expect(changed.record_digest).not.toBe(base.record_digest);
    expect(changed.input_digest).toBe(jcsDigest(input));
    if (label.includes("evaluation-irrelevant")) {
      // Everything except the two digests is byte-identical.
      const strip = (e: ShadowEvaluation) => {
        const { input_digest: _i, record_digest: _r, ...rest } = e;
        return canonicalize(rest);
      };
      expect(strip(changed)).toBe(strip(base));
    }
  });
});

describe("input_digest (3): key order and whitespace in input bytes do not matter", () => {
  it("compact, pretty, and key-reversed bytes of the same input -> identical input_digest and output bytes", () => {
    const input = loadInput();
    const compact = runReplay(JSON.stringify(input));
    const pretty = runReplay(`\n\n${JSON.stringify(input, null, 7)}\n\n`);
    const reversed = runReplay(JSON.stringify(reverseKeys(input), null, 1));
    expect(compact.status).toBe(0);
    expect(pretty.evaluation.input_digest).toBe(compact.evaluation.input_digest);
    expect(reversed.evaluation.input_digest).toBe(compact.evaluation.input_digest);
    expect(pretty.outBytes).toBe(compact.outBytes);
    expect(reversed.outBytes).toBe(compact.outBytes);
  });
});

describe("input_digest (3b): records[] array order IS part of the digest", () => {
  it("reversing records[] changes input_digest (a sort-then-hash implementation fails here)", () => {
    const input = loadInput();
    const reversedRecords = { ...input, records: [...input.records].reverse() };
    const a = evaluate(input);
    const b = evaluate(reversedRecords);
    // The evaluation itself is order-independent (input_manifest is sorted) ...
    expect(b.input_manifest).toEqual(a.input_manifest);
    expect(b.candidate_receipt).toEqual(a.candidate_receipt);
    // ... but input_digest binds the exact input as given.
    expect(b.input_digest).not.toBe(a.input_digest);
    expect(b.input_digest).toBe(jcsDigest(reversedRecords));
    expect(b.record_digest).not.toBe(a.record_digest);
  });

  it("CLI replay: reversed records[] in the input bytes -> different input_digest", () => {
    const input = loadInput();
    const a = runReplay(JSON.stringify(input));
    const b = runReplay(JSON.stringify({ ...input, records: [...input.records].reverse() }));
    expect(b.evaluation.input_digest).not.toBe(a.evaluation.input_digest);
    expect(b.evaluation.input_digest).toBe(
      jcsDigest(JSON.parse(readFileSync(b.inputPath, "utf-8"))),
    );
  });
});

describe("input_digest (4): SHADOW_EVALUATION_SCHEMA_V0", () => {
  const good = evaluate(loadInput());

  it("accepts the evaluator's own output", () => {
    expect(validateShadowEvaluation(good)).toEqual([]);
  });

  it("rejects a wrapper with input_digest absent", () => {
    const { input_digest: _drop, ...missing } = good;
    expect(validateShadowEvaluation(missing)).not.toEqual([]);
  });

  it.each([
    ["uppercase hex", `sha256:${"A".repeat(64)}`],
    ["short hex", `sha256:${"a".repeat(63)}`],
    ["long hex", `sha256:${"a".repeat(65)}`],
    ["wrong algorithm prefix", `sha512:${"a".repeat(64)}`],
    ["bare hex", "a".repeat(64)],
    ["empty string", ""],
  ])("rejects input_digest pattern violation: %s", (_label, value) => {
    expect(validateShadowEvaluation({ ...good, input_digest: value })).not.toEqual([]);
  });

  it("rejects a non-string input_digest", () => {
    expect(validateShadowEvaluation({ ...good, input_digest: null })).not.toEqual([]);
  });
});

describe("spec A3: candidate_receipt / receipt_id unchanged from before input_digest (base 213c2d1)", () => {
  // Captured by running the base-commit CLI on each pack: receipt_id verbatim, and
  // sha256(JCS(candidate_receipt)) for the full receipt bytes.
  const PINNED: Record<string, { receipt_id: string; receipt_jcs_sha256: string }> = {
    "lane-backed": {
      receipt_id: "sha256:a98d8c7651ab020b2ea29b46791c1ec44285851e93ed0230a09f2e294eb89dc0",
      receipt_jcs_sha256: "b97e35788ded02a1cf5846e6b45c4837497aeefcd93d6f9884484bef071acf74",
    },
    "lane-ref-omitted": {
      receipt_id: "sha256:a60d6ce6b0dbcfc22d8fc6451e1eea0a4440c6662800657dc206c56b3db9742c",
      receipt_jcs_sha256: "d1a1f66945fc533b6afd5abe5c5784c7c56bddccef97ff796b92638a957e76f0",
    },
  };

  it.each(Object.keys(PINNED))("pack %s", (name) => {
    const run = runReplay(readFileSync(path.join(PACKS_DIR, name, "input.json"), "utf-8"));
    expect(run.status).toBe(0);
    const receipt = run.evaluation.candidate_receipt;
    expect(receipt).not.toBeNull();
    expect(receipt?.receipt_id).toBe(PINNED[name]?.receipt_id);
    expect(createHash("sha256").update(canonicalize(receipt), "utf-8").digest("hex")).toBe(
      PINNED[name]?.receipt_jcs_sha256,
    );
    expect(run.evaluation.evaluator.version).toBe("0.1.0");
  });
});

// ---------------------------------------------------------------------------
// (5) cmdReplay self-verification (spec A4), run in-process with evaluate() swapped out so the
// only thing wrong is the input_digest binding. Uses the "unknown" input (candidate_receipt
// null) so the vendored receipt verifier is never reached.
// ---------------------------------------------------------------------------

const replayMode = vi.hoisted(() => ({ value: "passthrough" as string }));

vi.mock("../src/shadow/evaluate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/shadow/evaluate.js")>();
  const { computeRecordDigest: recordDigest } = await import("../src/shadow/serialize.js");
  return {
    ...actual,
    evaluate: (input: ShadowEvaluationInput): ShadowEvaluation => {
      if (replayMode.value === "wrong_digest") {
        // input_digest bound to some other input; record_digest kept self-consistent so the
        // record_digest check cannot be what catches it.
        const e = actual.evaluate(input);
        const tampered = { ...e, input_digest: `sha256:${"0".repeat(64)}` };
        return { ...tampered, record_digest: recordDigest(tampered) };
      }
      if (replayMode.value === "mutates_input") {
        // evaluate() mutating its argument in place: post-hoc recomputation over rawInput would
        // agree with the (mutated) digest, so only the digest captured before evaluate() catches it.
        input.records.reverse();
        return actual.evaluate(input);
      }
      return actual.evaluate(input);
    },
  };
});

async function runCmdReplayInProcess(mode: string): Promise<{ code: number; stderr: string }> {
  replayMode.value = mode;
  const dir = mkdtempSync(path.join(tmpdir(), "shadow-input-digest-a4-"));
  const inputPath = path.join(dir, "input.json");
  writeFileSync(inputPath, JSON.stringify(unknownInput()));
  const codes: number[] = [];
  const errors: string[] = [];
  class ExitCalled extends Error {}
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    codes.push(code ?? 0);
    // Throw only on the first call so execution stops there; main().catch's own follow-up
    // process.exit(2) is then just recorded instead of becoming an unhandled rejection.
    if (codes.length === 1) throw new ExitCalled();
    return undefined as never;
  }) as typeof process.exit);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  const savedArgv = process.argv;
  process.argv = [
    savedArgv[0] ?? "node",
    "main.js",
    "replay",
    "--input",
    inputPath,
    "--out",
    path.join(dir, "evaluation.json"),
  ];
  try {
    vi.resetModules();
    await import("../src/shadow-cli/main.js");
    await vi.waitFor(() => expect(codes.length).toBeGreaterThan(0));
  } finally {
    process.argv = savedArgv;
  }
  return { code: codes[0] as number, stderr: errors.join("\n") };
}

describe("input_digest (5): cmdReplay self-verification (spec A4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    replayMode.value = "passthrough";
  });

  it("control: an honest evaluate() passes and exits 0", async () => {
    const r = await runCmdReplayInProcess("passthrough");
    expect(r.stderr).not.toMatch(/input_digest/);
    expect(r.code).toBe(0);
  });

  it("evaluate() emitting an input_digest that does not match --input -> tool failure, exit 2", async () => {
    const r = await runCmdReplayInProcess("wrong_digest");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/input_digest that does not match/);
  });

  it("evaluate() mutating its input in place -> caught by the digest captured before evaluate(), exit 2", async () => {
    const r = await runCmdReplayInProcess("mutates_input");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/input_digest that does not match/);
  });

  it("verifyInputDigest: true for the input actually evaluated, false for any other", () => {
    const input = loadInput();
    const evaluation = evaluate(input);
    expect(verifyInputDigest(evaluation, input)).toBe(true);
    expect(verifyInputDigest(evaluation, JSON.parse(JSON.stringify(input)))).toBe(true);
    expect(verifyInputDigest(evaluation, unknownInput())).toBe(false);
    expect(verifyInputDigest(evaluation, { ...input, records: [...input.records].reverse() })).toBe(
      false,
    );
  });
});
