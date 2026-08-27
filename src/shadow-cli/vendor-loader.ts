// Loads a vendored playbook contract's OWN reference verifier as a real, executable module
// (terra review must-5, 2026-08-27: "production の検証経路で checkReceipt 相当の全 semantic
// verifier を実行する" -- not this evaluator's own hand-mirrored schema, the actual vendored
// verify-fixtures.mjs). fs/dynamic-import are fine here: this file lives in src/shadow-cli/**,
// the CLI layer spec.md already allows to touch fs (shadow core -- src/shadow/** -- never does).
//
// Problem this solves (same one test/shadow-conformance.test.ts already solved for the test
// layer, see that file's own header comment for the full story): every vendored verify-fixtures.mjs
// imports "../../shared/*.mjs", which only resolves inside the ORIGINAL playbook repo's directory
// topology (contracts/{promotion-receipt,shared}/... as siblings). This repo vendors that shared
// library separately at vendor/playbook-shared/, so importing
// vendor/playbook-contracts/promotion-receipt/v0/verify-fixtures.mjs AS VENDORED fails with
// ERR_MODULE_NOT_FOUND. Fix: reconstruct just enough of the original topology in a throwaway tmp
// dir -- a symlink for "shared" (never copied; vendor/playbook-shared/* is read-only source of
// truth) and a real byte-for-byte COPY of verify-fixtures.mjs itself (a symlinked .mjs would still
// report its pre-symlink realpath as import.meta.url when imported, reintroducing the exact same
// broken relative import) -- then dynamic-import the copy. Unlike
// test/shadow-conformance.test.ts's mirrorContract, this needs no `function runFixture( ->
// export function runFixture(` patch: both checkReceipt (promotion-receipt/v0) and checkRecord
// (review-findings/v1) are already exported by their own vendored files, and both guard their CLI
// `main()` with `if (isMainModule()) main();`, so importing them as a dependency never runs it.
//
// Caller contract: `withVendoredModule` awaits `use(mod)` BEFORE removing the tmp dir. This
// matters because the vendored file's own `createValidator(HERE)` (HERE = the tmp dir) loads its
// *.schema.json lazily, the first time `validate(...)` is actually called inside checkReceipt/
// checkRecord -- not at module-import time -- so the tmp dir (and its symlinked schema.json) must
// still exist at CALL time, not merely at import time.

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

/** Resolved via the `#contracts/*` / `#vendor/*` package-imports subpaths (package.json), never
 * via a path relative to this file's OWN location -- import.meta.resolve resolves the same way
 * whether this file is running as src/shadow-cli/vendor-loader.ts (vitest/dev) or the compiled
 * dist/src/shadow-cli/vendor-loader.js (the real bin, which has no dist/vendor/** of its own), so
 * there is no dev/dist directory-depth mismatch to get wrong (same technique this file's own
 * caller, main.ts, already used for the vendored promotion-receipt schema before this round).
 * Anchored on one file each side is known to vendor, since a bare directory specifier has nothing
 * concrete for import.meta.resolve to resolve against. */
function vendorContractsRoot(): string {
  const anchorFileUrl = import.meta.resolve(
    "#contracts/promotion-receipt/v0/promotion-receipt.schema.json",
  );
  const v0Dir = fileURLToPath(new URL(".", anchorFileUrl));
  return path.resolve(v0Dir, "..", ".."); // v0/ -> promotion-receipt/ -> playbook-contracts/
}

function vendorSharedRoot(): string {
  const anchorFileUrl = import.meta.resolve("#vendor/jcs.mjs");
  return fileURLToPath(new URL(".", anchorFileUrl));
}

const VENDOR_CONTRACTS = vendorContractsRoot();
const VENDOR_SHARED = vendorSharedRoot();

function symlinkPreservingType(src: string, dst: string): void {
  const type = statSync(src).isDirectory() ? "dir" : "file";
  symlinkSync(src, dst, type);
}

/** Mirrors one vendored contract directory (e.g. "promotion-receipt/v0") into a fresh tmp dir
 * alongside a `shared` symlink, reproducing the original playbook topology: symlinks everything
 * in the contract dir except verify-fixtures.mjs (fixtures/, the *.schema.json), and writes a
 * byte-identical copy of verify-fixtures.mjs itself. Never mutates vendor/ -- only reads it. */
async function withVendoredModule<T>(
  contractRelDir: string,
  use: (mod: Record<string, unknown>) => Promise<T> | T,
): Promise<T> {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "release-evidence-shadow-vendor-"));
  try {
    symlinkPreservingType(VENDOR_SHARED, path.join(tmpRoot, "shared"));
    const srcDir = path.join(VENDOR_CONTRACTS, contractRelDir);
    const dstDir = path.join(tmpRoot, contractRelDir);
    mkdirSync(dstDir, { recursive: true });
    for (const name of readdirSync(srcDir)) {
      if (name === "verify-fixtures.mjs") continue;
      symlinkPreservingType(path.join(srcDir, name), path.join(dstDir, name));
    }
    const verifierSource = readFileSync(path.join(srcDir, "verify-fixtures.mjs"), "utf-8");
    writeFileSync(path.join(dstDir, "verify-fixtures.mjs"), verifierSource);

    const mod = (await import(
      pathToFileURL(path.join(dstDir, "verify-fixtures.mjs")).href
    )) as Record<string, unknown>;
    return await use(mod);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

type CheckReceiptFn = (receipt: unknown) => string[];
type CheckRecordFn = (record: unknown) => string[];

/** Runs `receipt` through vendored promotion-receipt/v0's OWN `checkReceipt` -- schema validation
 * PLUS every semantic MUST the schema alone cannot express (predicate-set completeness, no
 * duplicates, resolvable-evidence-kind, real-calendar evaluated_at, semantic_digest
 * recomputation, verdict derivation) -- not this evaluator's own hand-mirrored
 * `candidateReceiptSchema` (input.ts), which is deliberately shallow. Returns an empty array when
 * valid. Throws if the vendored file's own exported shape ever changes (`checkReceipt` missing or
 * not a function) -- a drift this evaluator must not silently swallow. */
export async function checkReceiptAgainstVendoredVerifier(receipt: unknown): Promise<string[]> {
  return withVendoredModule(path.join("promotion-receipt", "v0"), (mod) => {
    const checkReceipt = mod.checkReceipt;
    if (typeof checkReceipt !== "function") {
      throw new Error(
        "vendored promotion-receipt/v0/verify-fixtures.mjs no longer exports checkReceipt -- update vendor-loader.ts",
      );
    }
    return (checkReceipt as CheckReceiptFn)(receipt);
  });
}

/** Runs `record` through vendored review-findings/v1's OWN `checkRecord` -- same discipline as
 * `checkReceiptAgainstVendoredVerifier` above, for review_finding_record content. */
export async function checkReviewFindingAgainstVendoredVerifier(
  record: unknown,
): Promise<string[]> {
  return withVendoredModule(path.join("review-findings", "v1"), (mod) => {
    const checkRecord = mod.checkRecord;
    if (typeof checkRecord !== "function") {
      throw new Error(
        "vendored review-findings/v1/verify-fixtures.mjs no longer exports checkRecord -- update vendor-loader.ts",
      );
    }
    return (checkRecord as CheckRecordFn)(record);
  });
}
