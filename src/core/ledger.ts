// Append-only JSONL release-events ledger. Two disciplines: (1) validate against schema
// BEFORE writing a line, never after; (2) the write itself is a single O_APPEND write of one
// line, never a read-modify-write of the whole file. (2) is what makes concurrent appends
// safe: two processes calling appendEvent on the same ledger at the same time both open with
// O_APPEND and each does exactly one write() of its own line -- the kernel serializes those
// writes without either process ever holding (and later overwriting) a stale copy of the
// other's line in memory. A prior read-then-writeFileSync-the-whole-file design lost whichever
// event lost the race, silently.
//
// There is deliberately no "restore on corruption after append" path anymore: a single
// O_APPEND write of one line has no partial-file failure mode that read-modify-write did
// (truncating the file mid-write). The remaining corruption case -- a ledger that was already
// broken before this call, e.g. a torn trailing line from a process that died mid-write -- is
// handled the same way it always was: readLedger() throws, and appendEvent refuses to touch a
// ledger it can't fully re-parse, rather than silently extending a file it can't verify.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { validateEvent } from "./event.js";
import type { ReleaseEvent } from "./types.js";

/** Reads and parses every line of the ledger file. Missing file = empty ledger (a ledger is
 * created by its first successful append, not by a separate init step). Throws with the line
 * number if any line is not valid JSON -- a ledger that can't be fully re-parsed is corrupt. */
export function readLedger(ledgerPath: string): ReleaseEvent[] {
  if (!existsSync(ledgerPath)) return [];
  const text = readFileSync(ledgerPath, "utf-8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as ReleaseEvent;
    } catch (err) {
      throw new Error(
        `ledger "${ledgerPath}" line ${i + 1} is not valid JSON: ${(err as Error).message}`,
      );
    }
  });
}

export interface AppendResult {
  /** false when this was an idempotent no-op: an event with the same event_id and identical
   * content was already the last thing recorded (a re-emitted event, per the schema's own
   * event_id description, is idempotent rather than duplicated). */
  appended: boolean;
  event: ReleaseEvent;
}

/** Validates `event` against release-event.schema.json and appends it as one atomic JSONL
 * line (O_APPEND, no read-modify-write). Refuses to write anything if validation fails, if the
 * ledger is already unparseable, or if event_id collides with a DIFFERENT existing event.
 * Callers are responsible for checking transition legality (fold.ts) and production gates
 * (gates.ts) BEFORE calling this -- ledger.ts only enforces single-record schema validity,
 * duplicate/conflict handling, and file integrity, not the state machine itself. */
export function appendEvent(ledgerPath: string, event: ReleaseEvent): AppendResult {
  const reasons = validateEvent(event);
  if (reasons.length > 0) {
    throw new Error(
      `event fails schema validation, refusing to append:\n${reasons.map((r) => `  - ${r}`).join("\n")}`,
    );
  }

  // Refuses a ledger it can't fully re-parse rather than silently extending it further --
  // this read is also how an idempotent replay is detected before ever touching the file.
  const existing = readLedger(ledgerPath);
  const duplicate = existing.find((e) => e.event_id === event.event_id);
  if (duplicate) {
    if (JSON.stringify(duplicate) !== JSON.stringify(event)) {
      throw new Error(
        `event_id "${event.event_id}" already exists in the ledger with different content -- refusing to append a conflicting record`,
      );
    }
    return { appended: false, event: duplicate };
  }

  appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, { encoding: "utf-8", flag: "a" });

  return { appended: true, event };
}
