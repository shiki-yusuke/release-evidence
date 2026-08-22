// Regression test for the read-modify-write race a prior ledger.ts design had: two processes
// appending to the same file both read the same "before" bytes and the last writer's
// writeFileSync of the WHOLE file clobbered the other's line. ledger.ts now does a single
// O_APPEND write per event instead (see its own header comment) -- this test spawns two real
// OS processes appending concurrently and asserts nothing was lost.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readLedger } from "../src/core/ledger.js";
import { HAS_CONTRACTS_DIR } from "./helpers.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(REPO_ROOT, "test", "fixtures", "concurrent-append-worker.mjs");

function runWorker(ledgerPath: string, prefix: string, count: number): Promise<unknown> {
  return execFileAsync(process.execPath, [WORKER, ledgerPath, prefix, String(count)], {
    env: process.env,
  });
}

describe.skipIf(!HAS_CONTRACTS_DIR)("concurrent ledger append", () => {
  let dir: string;
  let ledgerPath: string;

  beforeAll(() => {
    // The worker imports dist/src/core/ledger.js -- make sure it reflects current source.
    execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-evidence-ledger-concurrency-"));
    ledgerPath = path.join(dir, "release-events.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loses no lines when two processes append concurrently", async () => {
    const N = 30;
    await Promise.all([runWorker(ledgerPath, "a", N), runWorker(ledgerPath, "b", N)]);

    const events = readLedger(ledgerPath); // throws if any line is unparseable
    expect(events).toHaveLength(2 * N);

    const ids = events.map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length); // every line distinct, none merged/overwritten

    const aCount = events.filter((e) => e.event_id.startsWith("a-")).length;
    const bCount = events.filter((e) => e.event_id.startsWith("b-")).length;
    expect(aCount).toBe(N);
    expect(bCount).toBe(N);
  }, 30000);
});
