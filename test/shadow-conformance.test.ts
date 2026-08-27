// Conformance parity (chunk 3, spec.md test plan item 1): every accept/reject fixture vendored
// under vendor/playbook-contracts/{promotion-receipt/v0,review-findings/v1,release-approval/v0}
// must classify the same way its own fixtures/expected-results.json says -- using each contract's
// OWN reference verifier (verify-fixtures.mjs), not a hand-reimplementation of its semantic MUSTs
// (predicate completeness, verdict derivation, digest recomputation, cross-record evidence
// resolution, ...) that would risk drifting from the authoritative check. This mirrors
// test/conformance.test.ts's role for release-evidence/v0 (pin THIS implementation against every
// vendored fixture) but, unlike that file, this evaluator has no "own TS implementation" of these
// three contracts' full semantics to call -- it deliberately only does shallow, documented
// structural parsing of their content (implement-notes.md "chunk 2 の非自明な判断 3") -- so the
// authority to pin against here is each contract's own vendored reference verifier.
//
// Problem this file solves: each vendored verify-fixtures.mjs imports "../../shared/*.mjs" --
// in the ORIGINAL playbook repo that resolves to contracts/shared/, a sibling of
// contracts/promotion-receipt etc. This repo vendors that shared library separately, at
// vendor/playbook-shared/ (see vendor/playbook-contracts/VENDORED.md), so the relative import is
// unresolvable exactly as vendored -- `node vendor/playbook-contracts/promotion-receipt/v0/
// verify-fixtures.mjs` fails with ERR_MODULE_NOT_FOUND today. release-approval/v0's own
// verify-fixtures.mjs additionally imports "../../release-evidence/v0" (for embedded-bundle
// validation in its composite fixtures), which this repo never vendors at all --
// release-evidence/v0 is referenced only via RELEASE_EVIDENCE_CONTRACTS_DIR (test/helpers.ts),
// exactly like every other schema-backed test in this repo.
//
// Fix: reconstruct the ORIGINAL playbook directory topology (contracts/{promotion-receipt,
// review-findings,release-approval,shared}/...) in a throwaway tmp dir, using SYMLINKS for
// anything read only via fs (fixtures/, *.schema.json, vendor/playbook-shared/*) and PLAIN BYTE
// COPIES only for the three verify-fixtures.mjs files themselves -- a symlinked *.mjs would still
// report its pre-symlink realpath as import.meta.url when imported, which would reintroduce
// exactly the same broken relative import. This never touches vendor/ itself (only reads it).
// release-approval's "../../release-evidence/v0" only gets a real target when
// RELEASE_EVIDENCE_CONTRACTS_DIR is set (HAS_CONTRACTS_DIR, test/helpers.ts) -- composite-type
// fixtures (the only ones that embed a bundle) are skipped, exactly like every other
// schema-backed test in this repo, when it isn't (reported via helpers.ts's own console.warn, not
// a silent cap introduced here).
//
// The copied verify-fixtures.mjs files get exactly one textual patch, applied identically to all
// three and never to vendor/: `function runFixture(` -> `export function runFixture(` (none of
// the three export it, unlike checkReceipt/checkRecord which promotion-receipt/v0's and
// review-findings/v1's own files already export). Same behavior, not reimplemented -- this only
// exposes each file's own already-existing per-fixture dispatch (schema + every semantic MUST) so
// this test can call it, applied only to the throwaway tmp copy.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR, HAS_CONTRACTS_DIR } from "./helpers.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_CONTRACTS = path.join(REPO_ROOT, "vendor", "playbook-contracts");
const VENDOR_SHARED = path.join(REPO_ROOT, "vendor", "playbook-shared");

interface FixtureEntry {
  files: string;
  expected: "accept" | "reject";
  reason_code?: string;
  type?: "event" | "composite";
}

interface ExpectedResults {
  fixtures: FixtureEntry[];
}

interface ReferenceVerifierModule {
  runFixture: (entry: FixtureEntry) => { category: "accept" | "reject"; reasons: string[] };
}

const CONTRACT_RELATIVE_DIRS = {
  promotionReceipt: path.join("promotion-receipt", "v0"),
  reviewFindings: path.join("review-findings", "v1"),
  releaseApproval: path.join("release-approval", "v0"),
} as const;

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "release-evidence-shadow-conformance-"));

function symlinkPreservingType(src: string, dst: string): void {
  const type = statSync(src).isDirectory() ? "dir" : "file";
  symlinkSync(src, dst, type);
}

/** Mirrors one vendored contract directory into the tmp tree: symlinks everything except
 * verify-fixtures.mjs (fixtures/, the *.schema.json), and writes a byte-identical copy of
 * verify-fixtures.mjs with exactly the one export-visibility patch described above -- never a
 * behavior change. */
function mirrorContract(relDir: string): void {
  const srcDir = path.join(VENDOR_CONTRACTS, relDir);
  const dstDir = path.join(tmpRoot, relDir);
  mkdirSync(dstDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    if (name === "verify-fixtures.mjs") continue;
    symlinkPreservingType(path.join(srcDir, name), path.join(dstDir, name));
  }
  const original = readFileSync(path.join(srcDir, "verify-fixtures.mjs"), "utf-8");
  const occurrences = (original.match(/\nfunction runFixture\(/g) ?? []).length;
  if (occurrences !== 1) {
    throw new Error(
      `${relDir}/verify-fixtures.mjs: expected exactly one unexported "function runFixture(" to patch, found ${occurrences} -- the vendored file's shape has changed, update this patch`,
    );
  }
  let patched = original.replace("\nfunction runFixture(", "\nexport function runFixture(");
  // release-approval/v0's own verify-fixtures.mjs calls `main();` UNCONDITIONALLY at the bottom
  // (unlike promotion-receipt/v0's and review-findings/v1's own files, both of which guard it with
  // `if (isMainModule()) main();`) -- importing it as a dependency (which THIS harness does, and
  // which release-approval's own verify-fixtures.mjs also does for review-findings'/
  // promotion-receipt's checkRecord/checkReceipt) would otherwise always run its CLI main(),
  // including process.exit(). Stripped only when present, only from our own tmp copy -- never
  // from vendor/, never changing what runFixture itself does.
  patched = patched.replace(/\nmain\(\);\s*$/, "\n");
  writeFileSync(path.join(dstDir, "verify-fixtures.mjs"), patched);
}

symlinkPreservingType(VENDOR_SHARED, path.join(tmpRoot, "shared"));
for (const relDir of Object.values(CONTRACT_RELATIVE_DIRS)) mirrorContract(relDir);
if (HAS_CONTRACTS_DIR && CONTRACTS_DIR) {
  mkdirSync(path.join(tmpRoot, "release-evidence"), { recursive: true });
  symlinkPreservingType(CONTRACTS_DIR, path.join(tmpRoot, "release-evidence", "v0"));
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const promotionReceiptMod = (await import(
  pathToFileURL(path.join(tmpRoot, CONTRACT_RELATIVE_DIRS.promotionReceipt, "verify-fixtures.mjs"))
    .href
)) as ReferenceVerifierModule;
const reviewFindingsMod = (await import(
  pathToFileURL(path.join(tmpRoot, CONTRACT_RELATIVE_DIRS.reviewFindings, "verify-fixtures.mjs"))
    .href
)) as ReferenceVerifierModule;
const releaseApprovalMod = (await import(
  pathToFileURL(path.join(tmpRoot, CONTRACT_RELATIVE_DIRS.releaseApproval, "verify-fixtures.mjs"))
    .href
)) as ReferenceVerifierModule;

function readExpectedResults(fixturesDir: string): ExpectedResults {
  return JSON.parse(
    readFileSync(path.join(fixturesDir, "expected-results.json"), "utf-8"),
  ) as ExpectedResults;
}

function assertNoFixtureDrift(fixturesDir: string, manifest: ExpectedResults): void {
  const declared = new Set(manifest.fixtures.map((f) => f.files));
  expect(declared.size).toBe(manifest.fixtures.length); // no fixture declared twice
  const onDisk = readdirSync(fixturesDir).filter(
    (f) => f.endsWith(".json") && f !== "expected-results.json",
  );
  expect([...onDisk].sort()).toEqual([...declared].sort());
}

function conformanceSuite(
  label: string,
  fixturesDir: string,
  mod: ReferenceVerifierModule,
  opts: { skipIf?: (entry: FixtureEntry) => boolean } = {},
): void {
  describe(label, () => {
    const manifest = readExpectedResults(fixturesDir);

    it("expected-results.json declares every fixture on disk, and only those (drift guard)", () => {
      assertNoFixtureDrift(fixturesDir, manifest);
    });

    for (const entry of manifest.fixtures) {
      it.skipIf(opts.skipIf?.(entry) ?? false)(`${entry.files} behaves as declared`, () => {
        const result = mod.runFixture(entry);
        expect(result.category).toBe(entry.expected);
        if (entry.expected === "reject" && entry.reason_code) {
          expect(result.reasons.some((r) => r.includes(entry.reason_code as string))).toBe(true);
        }
      });
    }
  });
}

conformanceSuite(
  "promotion-receipt/v0 conformance (vendored fixtures, reference verifier)",
  path.join(VENDOR_CONTRACTS, CONTRACT_RELATIVE_DIRS.promotionReceipt, "fixtures"),
  promotionReceiptMod,
);

conformanceSuite(
  "review-findings/v1 conformance (vendored fixtures, reference verifier)",
  path.join(VENDOR_CONTRACTS, CONTRACT_RELATIVE_DIRS.reviewFindings, "fixtures"),
  reviewFindingsMod,
);

conformanceSuite(
  "release-approval/v0 conformance (vendored fixtures, reference verifier)",
  path.join(VENDOR_CONTRACTS, CONTRACT_RELATIVE_DIRS.releaseApproval, "fixtures"),
  releaseApprovalMod,
  {
    // Composite fixtures embed a release-evidence/v0 bundle and validate it against that
    // contract's OWN schema (checkEmbeddedBundle -> validateReleaseEvidence) -- unlike
    // event-type fixtures, which need nothing outside this repo's vendored tree at all.
    skipIf: (entry) => entry.type === "composite" && !HAS_CONTRACTS_DIR,
  },
);
