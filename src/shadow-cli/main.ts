#!/usr/bin/env node
// release-evidence-shadow CLI: `replay --input <shadow-evaluation-input file> [--out <file>]`.
// This is the ONLY entry point into src/shadow/** that touches fs/process (spec.md "決定論":
// "fs は resolver の入力読み込み層だけ" -- resolver.ts reads the exact-record CONTENT already
// embedded in the input file; THIS file is where the input file itself is read, parsed, and
// schema-checked, and where the vendored promotion-receipt/v0 contract's own reference verifier
// (vendor-loader.ts) is loaded for full-fidelity verification of any candidate_receipt evaluate()
// produces).
//
// mode is literal "shadow_only" (evaluate.ts hardcodes it) and there is no --enforce / --fail-on-*
// / --promote / --approve flag (spec.md "live 化の構造的防止") -- this bin never gates anything,
// it only records a deterministic replay result.
//
// Exit codes: 0 = a shadow-evaluation record was produced, REGARDLESS of its verdict --
// ineligible/abstained/unknown are all legitimate, successfully recorded outcomes (spec.md:
// "verdict（ineligible/abstained/unknown）でも CLI は exit 0"). Non-zero (2) is reserved for
// exactly two things: malformed input (unreadable file, JSON parse failure, schema-invalid
// shadow-evaluation-input, or evaluate() itself reporting evaluation_status="invalid_input" --
// tampered/unsupported exact records) and tool failure (this evaluator produced a
// candidate_receipt that fails full-fidelity verification against the vendored
// promotion-receipt/v0 contract's own reference verifier, or a wrapper self-digest doesn't
// recompute to what evaluate() stored -- a bug in this tool, not in the input).

import { readFileSync, writeFileSync } from "node:fs";
import { evaluate } from "../shadow/evaluate.js";
import {
  type ShadowEvaluationInput,
  validateShadowEvaluation,
  validateShadowEvaluationInput,
} from "../shadow/input.js";
import { serializeShadowEvaluation } from "../shadow/serialize.js";
import {
  verifyInputManifestDigest,
  verifyPredicateProjection,
  verifyRecordDigest,
} from "../shadow/verify.js";
import { checkReceiptAgainstVendoredVerifier } from "./vendor-loader.js";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags; repeated: string[] } {
  const positional: string[] = [];
  const flags: Flags = {};
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
    if (seen.has(name)) repeated.push(name);
    seen.add(name);
    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags, repeated };
}

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function requireString(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) fail(`missing required flag --${name}`);
  return value;
}

const USAGE =
  "release-evidence-shadow replay --input <shadow-evaluation-input file> [--out <file>]";
const ALLOWED_FLAGS = ["input", "out", "help", "h"];

function printHelp(): void {
  console.log(USAGE);
}

/** Full-fidelity verification of a generated candidate_receipt against the vendored
 * promotion-receipt/v0 contract's OWN reference verifier (`checkReceipt`, via vendor-loader.ts --
 * terra review must-5, 2026-08-27: "production の検証経路で checkReceipt 相当の全 semantic
 * verifier を実行する"). This runs schema validation AND every semantic MUST the schema alone
 * cannot express (predicate-set completeness/no-duplicates, resolvable-evidence-kind,
 * real-calendar evaluated_at, semantic_digest recomputation, verdict derivation) -- this
 * evaluator's own input.ts `candidateReceiptSchema` is a hand-written, schema-only mirror used
 * for cheap in-memory structural checks elsewhere; THIS is the authority. Returns an empty array
 * when valid. */
async function verifyCandidateReceiptFullFidelity(candidateReceipt: unknown): Promise<string[]> {
  return checkReceiptAgainstVendoredVerifier(candidateReceipt);
}

async function cmdReplay(flags: Flags): Promise<void> {
  const inputPath = requireString(flags, "input");
  const outPath = typeof flags.out === "string" ? flags.out : undefined;

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(readFileSync(inputPath, "utf-8"));
  } catch (err) {
    fail(
      `could not read/parse --input "${inputPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const inputSchemaReasons = validateShadowEvaluationInput(rawInput);
  if (inputSchemaReasons.length > 0) {
    console.error(`--input "${inputPath}" is not a valid shadow-evaluation-input/v0:`);
    for (const r of inputSchemaReasons) console.error(`  - ${r}`);
    process.exit(2);
  }

  const evaluation = evaluate(rawInput as ShadowEvaluationInput);

  const wrapperSchemaReasons = validateShadowEvaluation(evaluation);
  if (wrapperSchemaReasons.length > 0) {
    console.error(
      "evaluate() produced a shadow-evaluation/v0 that fails its own schema (tool failure):",
    );
    for (const r of wrapperSchemaReasons) console.error(`  - ${r}`);
    process.exit(2);
  }

  if (evaluation.candidate_receipt !== null) {
    const receiptReasons = await verifyCandidateReceiptFullFidelity(evaluation.candidate_receipt);
    if (receiptReasons.length > 0) {
      console.error(
        "candidate_receipt failed full-fidelity verification against the vendored promotion-receipt/v0 reference verifier (tool failure):",
      );
      for (const r of receiptReasons) console.error(`  - ${r}`);
      process.exit(2);
    }
  }

  // Wrapper self-consistency (terra review must-5): the evaluator's OWN self-digests and its OWN
  // observation→receipt projection must recompute to what evaluate() actually stored, not merely
  // look schema-shaped. A mismatch here is this tool's own bug, never the caller's input.
  if (!verifyRecordDigest(evaluation)) {
    fail(
      "evaluate() produced a record_digest that does not match a fresh recomputation (tool failure)",
    );
  }
  if (!verifyInputManifestDigest(evaluation)) {
    fail(
      "evaluate() produced an input_manifest.digest that does not match a fresh recomputation (tool failure)",
    );
  }
  if (!verifyPredicateProjection(evaluation)) {
    fail(
      "evaluate()'s candidate_receipt.predicates is not the mechanical projection of predicate_observations (tool failure)",
    );
  }

  const bytes = serializeShadowEvaluation(evaluation);
  if (outPath) {
    writeFileSync(outPath, bytes);
  } else {
    process.stdout.write(bytes);
  }

  if (evaluation.evaluation_status === "invalid_input") {
    console.error(
      `evaluation_status is "invalid_input" -- input_errors: ${JSON.stringify(evaluation.input_errors)}`,
    );
    process.exit(2);
  }

  // evaluation_status is "evaluated" or "unknown", and any candidate_receipt.verdict
  // (ready_for_approval/ineligible/abstained) -- all legitimate, successfully recorded shadow
  // results. exit 0 unconditionally (spec.md "live 化の構造的防止").
  process.exit(0);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd) {
    printHelp();
    process.exit(2);
  }
  if (cmd !== "replay") {
    console.error(`unknown command "${cmd}"\n`);
    printHelp();
    process.exit(2);
  }

  const { positional, flags, repeated } = parseArgs(rest);
  if (positional.length > 0) {
    fail(`unexpected extra argument "${positional[0]}"\n\nusage: ${USAGE}`);
  }
  if (repeated.length > 0) {
    fail(`flag --${repeated[0]} was given more than once`);
  }
  const allowed = new Set(ALLOWED_FLAGS);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) fail(`unknown flag --${key}\n\nusage: ${USAGE}`);
  }
  if (flags.help || flags.h) {
    printHelp();
    process.exit(0);
  }

  await cmdReplay(flags);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
