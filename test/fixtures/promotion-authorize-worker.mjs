// Worker process for test/promotion-concurrency.test.ts: one `promote authorize` against its own
// ledger clone of the shared bare remote. Imports the BUILT modules (dist/) because the race
// under test is between two real OS processes pushing to the same ref. A file barrier holds both
// workers right before their first push, so both build on the same head and exactly one lease
// can win; the loser must re-fetch, re-fold and re-evaluate.
//
// argv: <scenario.json> <run-id> <ledger-dir>

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPromote } from "../../dist/src/promotion/commands.js";
import { makeFetch } from "../../dist/test/promotion-fixtures.js";

const [, , scenarioPath, runId, ledgerDir] = process.argv;
const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));

const deps = {
  fetch: makeFetch(scenario.state),
  validateBundle: () => [],
  checkReceipt: async () => [],
  hooks: {
    beforePush: async (attempt) => {
      if (attempt !== 1) return;
      writeFileSync(path.join(scenario.barrierDir, runId), "");
      const deadline = Date.now() + 20000;
      while (readdirSync(scenario.barrierDir).length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  },
};

const result = await runPromote(
  "authorize",
  {
    ...scenario.flags,
    "ledger-repo": ledgerDir,
    "run-id": runId,
    "evidence-archive": scenario.evidenceArchives[runId],
  },
  deps,
);
process.stdout.write(JSON.stringify(result));
