// Append-only JSONL release-events ledger. Two disciplines, same as this repo's other
// finalize-style JSONL writers: (1) validate against schema BEFORE writing a line, never
// after; (2) after appending, re-parse every line in the file, and if the result is broken,
// restore the exact pre-append bytes rather than leaving a half-written file behind. Nothing
// in this file ever rewrites or removes a past line -- corrections are new events, and current
// state is always derived by folding (fold.ts), never stored here.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** Validates `event` against release-event.schema.json and appends it as one JSONL line.
 * Refuses to write anything if validation fails. Callers are responsible for checking
 * transition legality (fold.ts) and production gates (gates.ts) BEFORE calling this --
 * ledger.ts only enforces single-record schema validity and file integrity, not the state
 * machine. */
export function appendEvent(ledgerPath: string, event: ReleaseEvent): AppendResult {
  const reasons = validateEvent(event);
  if (reasons.length > 0) {
    throw new Error(
      `event fails schema validation, refusing to append:\n${reasons.map((r) => `  - ${r}`).join("\n")}`,
    );
  }

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

  const before = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf-8") : "";
  const after = `${before}${JSON.stringify(event)}\n`;
  writeFileSync(ledgerPath, after, "utf-8");

  try {
    readLedger(ledgerPath); // full re-parse verification
  } catch (err) {
    writeFileSync(ledgerPath, before, "utf-8"); // restore pre-append bytes
    throw new Error(
      `append produced an unparseable ledger; restored previous content. Cause: ${(err as Error).message}`,
    );
  }

  return { appended: true, event };
}
