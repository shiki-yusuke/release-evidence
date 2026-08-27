#!/usr/bin/env node
// Verifies contracts/review-findings/v1/fixtures/* against review-findings.schema.json plus the
// semantic MUSTs the schema alone cannot express (docs/protocols/review-findings-v1.md):
//
//   finding_id uniqueness within one record (a single-record schema cannot see its own
//   siblings, same reason release-evidence/v0 folds duplicate event_id at collection level);
//   no numeric "confidence" field anywhere, including inside the open params bags
//   (assessor.independence.params, findings[].evidence_gate.predicate.params) that
//   additionalProperties:false cannot reach because those bags are intentionally open;
//   the personal-dimension scan, same as every other contract in this repo.
//
// Zero npm dependencies by design. Usage: node verify-fixtures.mjs (no args, no network).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createValidator } from "../../shared/schema-validator.mjs";
import { scanPersonalDimensions } from "../../shared/personal-dimensions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");
const { validate } = createValidator(HERE);

const read = (f) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, f), "utf-8"));
const dedupe = (a) => [...new Set(a)];

// R7: "SHALL NOT contain numeric confidence fields anywhere." additionalProperties:false closes
// off the named object shapes, but assessor.independence.params and
// findings[].evidence_gate.predicate.params are intentionally OPEN dictionaries (arbitrary
// {code, params} records, same shape contracts/shared/derive-independence.mjs emits) -- a
// numeric confidence smuggled into one of those bags would not be caught by the schema alone.
// Broadened (sol architect should-4): matches any key whose lowercased name CONTAINS
// "confidence" (e.g. "confidenceScore"), not only an exact "confidence" key -- copied
// identically into promotion-receipt/v0's and release-approval/v0's own verify-fixtures.mjs
// (contracts/shared cannot be touched, so this lives in all three).
function scanNumericConfidence(value, pathStr = "") {
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

function isRealTimestamp(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

// R5 (Revision 2, sol architect should-2): locations[].start_line/end_line must be both null or
// both non-null (never one recorded and the other missing), and when both are recorded,
// end_line >= start_line -- a schema-level `type: ["integer","null"]` cannot express either
// cross-field relationship on its own.
function checkLocationConsistency(record) {
  const reasons = [];
  for (const f of record.findings ?? []) {
    for (const [i, loc] of (f.locations ?? []).entries()) {
      const bothNull = loc.start_line === null && loc.end_line === null;
      const bothSet = loc.start_line !== null && loc.end_line !== null;
      if (!bothNull && !bothSet) {
        reasons.push(`location_line_partial: finding "${f.finding_id}" locations[${i}] has only one of start_line/end_line recorded`);
      } else if (bothSet && loc.end_line < loc.start_line) {
        reasons.push(`location_line_order: finding "${f.finding_id}" locations[${i}] end_line ${loc.end_line} < start_line ${loc.start_line}`);
      }
    }
  }
  return dedupe(reasons);
}

export function checkRecord(record) {
  const reasons = [];
  reasons.push(...validate("review-findings.schema.json", record));
  reasons.push(...scanPersonalDimensions(record).map((v) => `personal_dimension_forbidden_key: ${v}`));
  reasons.push(...scanNumericConfidence(record).map((v) => `numeric_confidence_forbidden_field: ${v}`));
  if (!isRealTimestamp(record.recorded_at)) {
    reasons.push(`invalid_calendar_timestamp: record "${record.record_id}" recorded_at "${record.recorded_at}" does not parse to a real date/time`);
  }
  if (reasons.length > 0) return dedupe(reasons);

  const ids = (record.findings ?? []).map((f) => f.finding_id);
  for (const dup of dedupe(ids.filter((id, i) => ids.indexOf(id) !== i))) {
    reasons.push(`duplicate_finding_id: "${dup}" appears more than once in record "${record.record_id}"`);
  }
  reasons.push(...checkLocationConsistency(record));
  return dedupe(reasons);
}

function runFixture(entry) {
  const problems = checkRecord(read(entry.files));
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
  console.log(`review-findings:v1 fixture verification (${manifest.fixtures.length} fixtures)\n`);
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
