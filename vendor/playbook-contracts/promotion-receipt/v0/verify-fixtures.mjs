#!/usr/bin/env node
// Verifies contracts/promotion-receipt/v0/fixtures/* against promotion-receipt.schema.json plus
// the semantic MUSTs the schema alone cannot express (docs/protocols/promotion-receipt-v0.md):
//
//   verdict derivation (R10): applicable contradicted (>=1) -> ineligible; else applicable
//   unknown (>=1) -> abstained; else (all applicable satisfied) -> ready_for_approval. A
//   declared verdict that does not match this derivation is rejected regardless of what the
//   fixture claims.
//
//   semantic_digest recomputation (R12): sha256 of the JCS canonical bytes of the receipt with
//   evaluated_at, receipt_id, and semantic_digest itself removed. A mismatch is rejected -- this
//   is the TOCTOU identity the release-approval/v0 composite fixture later compares against.
//
//   personal-dimension scan + numeric-confidence scan, same discipline as every contract in
//   this repo (no open params bag exists in this schema today, but the scan runs regardless so
//   a future field addition cannot silently reintroduce either).
//
//   predicate-set completeness (R21, sol architect must-1): a pre_promotion receipt must carry
//   all six pre_promotion predicate_ids exactly once (no fewer, no duplicates); a post_deploy
//   receipt must carry deployed_artifact_readback exactly once. The three always-on
//   pre_promotion predicates (artifact_identity, review_admissibility, verification_coverage)
//   and post_deploy's own deployed_artifact_readback must be applicability=applicable -- this
//   closes the escape hatch ask-2 flagged: marking every predicate not_applicable used to derive
//   ready_for_approval (deriveVerdict sees zero applicable predicates and defaults favorably).
//
//   resolvable evidence kind (R9, sol architect must-2a, structural half): a satisfied or
//   contradicted predicate must cite at least one evidence_refs entry whose kind is
//   review_finding or release_evidence -- "other" alone is auxiliary information and can never
//   by itself back a satisfied/contradicted status. This is the half of R9 checkable without a
//   ledger: whether the cited evidence ACTUALLY resolves to something real is release-approval/
//   v0's composite fixture's job (it alone carries the referenced records/bundles).
//
//   real-date semantics: the UTC-Z pattern in the schema accepts syntactically well-formed but
//   calendar-nonsensical strings (e.g. "2026-99-99T00:00:00Z"); Date.parse resolves those to NaN
//   and this verifier rejects them.
//
// Zero npm dependencies by design. Usage: node verify-fixtures.mjs (no args, no network).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";
import { canonicalize, sha256hex } from "../../shared/jcs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];

// Broadened (sol architect should-4): matches any key whose lowercased name CONTAINS
// "confidence" (e.g. "confidenceScore", "Confidence_Level"), not only an exact "confidence"
// key -- copied identically into review-findings/v1's and release-approval/v0's own
// verify-fixtures.mjs (contracts/shared cannot be touched, so this lives in all three).
export function scanNumericConfidence(value, pathStr = "") {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...scanNumericConfidence(item, `${pathStr}[${i}]`)));
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (key.toLowerCase().includes("confidence") && typeof val === "number") violations.push(here);
      violations.push(...scanNumericConfidence(val, here));
    }
  }
  return violations;
}

// R21: closed predicate_id sets per phase, and which of them may never be not_applicable.
export const PRE_PROMOTION_PREDICATE_IDS = Object.freeze([
  "artifact_identity",
  "review_admissibility",
  "verification_coverage",
  "preview_verified",
  "rollback_target_valid",
  "privilege_boundary",
]);
export const POST_DEPLOY_PREDICATE_IDS = Object.freeze(["deployed_artifact_readback"]);
export const ALWAYS_APPLICABLE_PREDICATE_IDS = Object.freeze([
  "artifact_identity",
  "review_admissibility",
  "verification_coverage",
  "deployed_artifact_readback",
]);

export function checkPredicateCompleteness(receipt) {
  const reasons = [];
  const expected = receipt.evaluation_phase === "pre_promotion" ? PRE_PROMOTION_PREDICATE_IDS : POST_DEPLOY_PREDICATE_IDS;
  const ids = receipt.predicates.map((p) => p.predicate_id);
  for (const id of expected) {
    if (!ids.includes(id)) reasons.push(`predicate_missing: receipt "${receipt.receipt_id}" is missing required predicate_id "${id}" for phase "${receipt.evaluation_phase}"`);
  }
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    reasons.push(`predicate_duplicate: predicate_id "${dup}" appears more than once in receipt "${receipt.receipt_id}"`);
  }
  for (const p of receipt.predicates) {
    if (ALWAYS_APPLICABLE_PREDICATE_IDS.includes(p.predicate_id) && p.applicability !== "applicable") {
      reasons.push(`predicate_must_be_applicable: "${p.predicate_id}" is always-on and cannot be not_applicable (receipt "${receipt.receipt_id}")`);
    }
  }
  return dedupe(reasons);
}

// R9 structural half: a satisfied/contradicted predicate needs at least one evidence_refs entry
// of a KIND that can in principle be resolved (review_finding or release_evidence) -- "other" is
// auxiliary-only. Whether that entry ACTUALLY resolves is release-approval/v0's composite job.
export function checkResolvableEvidenceKind(receipt) {
  const reasons = [];
  for (const p of receipt.predicates) {
    if (p.status !== "satisfied" && p.status !== "contradicted") continue;
    const hasResolvableKind = p.evidence_refs.some((r) => r.kind === "review_finding" || r.kind === "release_evidence");
    if (!hasResolvableKind) {
      reasons.push(`no_resolvable_evidence_kind: predicate "${p.predicate_id}" is "${p.status}" but cites no review_finding/release_evidence evidence_ref (an "other"-only ref cannot back this status)`);
    }
  }
  return dedupe(reasons);
}

function isRealTimestamp(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

// R12: excludes evaluated_at, receipt_id, semantic_digest from the digested object.
export function computeSemanticDigest(receipt) {
  const { evaluated_at, receipt_id, semantic_digest, ...rest } = receipt;
  return `sha256:${sha256hex(canonicalize(rest))}`;
}

// R10: the verdict a receipt's own predicate vector implies.
export function deriveVerdict(predicates) {
  const applicable = predicates.filter((p) => p.applicability === "applicable");
  if (applicable.some((p) => p.status === "contradicted")) return "ineligible";
  if (applicable.some((p) => p.status === "unknown")) return "abstained";
  return "ready_for_approval";
}

export function checkReceipt(receipt) {
  const reasons = [];
  reasons.push(...validate("promotion-receipt.schema.json", receipt));
  reasons.push(...scanPersonalDimensions(receipt).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...scanNumericConfidence(receipt).map((v) => `numeric_confidence_forbidden_field: ${v}`));
  if (reasons.length > 0) return dedupe(reasons);

  if (!isRealTimestamp(receipt.evaluated_at)) {
    reasons.push(`invalid_calendar_timestamp: receipt "${receipt.receipt_id}" evaluated_at "${receipt.evaluated_at}" does not parse to a real date/time`);
  }

  reasons.push(...checkPredicateCompleteness(receipt));
  reasons.push(...checkResolvableEvidenceKind(receipt));
  if (reasons.length > 0) return dedupe(reasons);

  const expectedDigest = computeSemanticDigest(receipt);
  if (receipt.semantic_digest !== expectedDigest) {
    reasons.push(
      `semantic_digest_mismatch: receipt "${receipt.receipt_id}" declares ${receipt.semantic_digest}, recomputed ${expectedDigest}`,
    );
  }

  const derived = deriveVerdict(receipt.predicates);
  if (receipt.verdict !== derived) {
    reasons.push(
      `verdict_derivation_mismatch: receipt "${receipt.receipt_id}" declares verdict "${receipt.verdict}" but the predicate vector derives "${derived}"`,
    );
  }

  return dedupe(reasons);
}

function runFixture(entry) {
  const problems = checkReceipt(read(entry.files));
  return { category: problems.length ? "reject" : "accept", reasons: problems };
}

function main() {
  const manifest = read("expected-results.json");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    console.error("expected-results.json declares zero fixtures -- refusing to report success.");
    process.exit(1);
  }
  const declared = new Set(manifest.fixtures.map((e) => e.files));
  if (declared.size !== manifest.fixtures.length) {
    console.error("expected-results.json lists the same fixture twice -- refusing.");
    process.exit(1);
  }
  const onDisk = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json") && f !== "expected-results.json");
  const undeclared = onDisk.filter((f) => !declared.has(f));
  const missing = [...declared].filter((f) => !onDisk.includes(f));
  if (undeclared.length > 0 || missing.length > 0) {
    console.error(`fixture/manifest drift -- undeclared on disk: [${undeclared}] / declared but absent: [${missing}]`);
    process.exit(1);
  }

  let failures = 0;
  console.log(`promotion-receipt:v0 fixture verification (${manifest.fixtures.length} fixtures)\n`);
  for (const entry of manifest.fixtures) {
    const result = runFixture(entry);
    let ok = result.category === entry.expected;
    if (ok && entry.expected === "reject" && entry.reason_code) {
      ok = result.reasons.some((r) => r.includes(entry.reason_code));
    }
    const status = ok ? "PASS" : "FAIL";
    if (!ok) failures++;
    console.log(`[${status}] ${entry.files}  (expected=${entry.expected}, got=${result.category})`);
    if (!ok) for (const r of result.reasons) console.log(`        ${r}`);
  }
  console.log(`\n${manifest.fixtures.length - failures}/${manifest.fixtures.length} fixtures behave as declared.`);
  process.exit(failures > 0 ? 1 : 0);
}

function isMainModule() {
  return process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) main();
