// Two real processes race to consume the same approval for two different promotions. The git
// ref CAS (push --force-with-lease) is the linearization point: exactly one authorized lands;
// the loser re-evaluates against the winner's head and is refused (exit 3) without writing.

import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  addSourceRun,
  authorizeFlags,
  evidenceArchiveOf,
  makeApproval,
  makeSandbox,
  newLedgerClone,
  remoteLedger,
  writeAuthority,
} from "./promotion-fixtures.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(REPO_ROOT, "test", "fixtures", "promotion-authorize-worker.mjs");

describe("promotion ledger CAS under concurrent writers", () => {
  it("two workers consuming one approval: one winner, the loser re-evaluates and is refused", async () => {
    const sb = makeSandbox();
    try {
      const approval = makeApproval({ subject: sb.subject });
      writeAuthority(sb, [approval]);
      addSourceRun(sb, "1002", 1);
      const barrierDir = path.join(sb.root, "barrier");
      mkdirSync(barrierDir);
      const scenarioPath = path.join(sb.root, "scenario.json");
      writeFileSync(
        scenarioPath,
        JSON.stringify({
          state: sb.state,
          flags: authorizeFlags(sb, approval.event_id),
          evidenceArchives: {
            "1001": evidenceArchiveOf(sb, "1001", 1),
            "1002": evidenceArchiveOf(sb, "1002", 1),
          },
          barrierDir,
        }),
      );
      const runs = ["1001", "1002"].map((runId) =>
        execFileAsync(process.execPath, [
          WORKER,
          scenarioPath,
          runId,
          newLedgerClone(sb, `w${runId}`),
        ]),
      );
      const results = (await Promise.all(runs)).map(
        (r) => JSON.parse(r.stdout) as { exitCode: number; output: Record<string, unknown> },
      );
      const codes = results.map((r) => r.exitCode).sort();
      expect(codes, JSON.stringify(results)).toEqual([0, 3]);
      const loser = results.find((r) => r.exitCode === 3);
      expect(String(loser?.output.error)).toMatch(/locked|already consumed/);
      const ledger = remoteLedger(sb);
      expect(ledger.filter((e) => e.kind === "authorized")).toHaveLength(1);
      expect(ledger.filter((e) => e.kind === "authority_ingested")).toHaveLength(1);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  }, 60_000);
});
