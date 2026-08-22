// Standalone worker process for the concurrent-append test (test/ledger-concurrency.test.ts).
// Imports the BUILT ledger module (dist/), not the .ts source -- this needs to be a real OS
// process the test can spawn twice in parallel, not an in-process function call, since the
// bug under test (a read-modify-write race) only shows up across genuinely concurrent
// processes racing the same file. Each of the N events is its own independent attempt (a
// distinct bundle_digest), so there is no cross-event ordering constraint within one worker's
// run -- only the ledger file itself is shared.
//
// argv: <ledgerPath> <prefix> <count>

import { createHash } from "node:crypto";
import { appendEvent } from "../../dist/src/core/ledger.js";

const [, , ledgerPath, prefix, countStr] = process.argv;
const count = Number(countStr);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

for (let i = 0; i < count; i++) {
  const event = {
    schema_version: "release-evidence/v0",
    event_id: `${prefix}-${i}-${sha256(`${prefix}-event-${i}`).slice(0, 16)}`,
    release_id: `concurrent-${prefix}@${i}.0.0`,
    kind: "prepared",
    environment: null,
    occurred_at: new Date().toISOString(),
    actor: "cli",
    bundle_digest: `sha256:${sha256(`${prefix}-digest-${i}`)}`,
  };
  appendEvent(ledgerPath, event);
}
