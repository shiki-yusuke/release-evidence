import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, readLedger } from "../src/core/ledger.js";
import type { ReleaseEvent } from "../src/core/types.js";
import { HAS_CONTRACTS_DIR } from "./helpers.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function prepared(eventId: string): ReleaseEvent {
  return {
    schema_version: "release-evidence/v0",
    event_id: eventId,
    release_id: "demo@1.0.0",
    kind: "prepared",
    environment: null,
    occurred_at: "2026-08-22T00:00:00Z",
    actor: "cli",
    bundle_digest: DIGEST,
  };
}

describe.skipIf(!HAS_CONTRACTS_DIR)("ledger", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "release-evidence-ledger-"));
    ledgerPath = path.join(dir, "release-events.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads an empty (nonexistent) ledger as an empty array", () => {
    expect(readLedger(ledgerPath)).toEqual([]);
  });

  it("appends one event and reads it back", () => {
    const result = appendEvent(ledgerPath, prepared("1"));
    expect(result.appended).toBe(true);
    expect(readLedger(ledgerPath)).toEqual([prepared("1")]);
  });

  it("refuses to append an event that fails schema validation, and writes nothing", () => {
    const bad = { ...prepared("1"), environment: "preview" } as unknown as ReleaseEvent; // prepared must be environment: null
    expect(() => appendEvent(ledgerPath, bad)).toThrow(/schema validation/);
    expect(readLedger(ledgerPath)).toEqual([]);
  });

  it("treats a re-append of the identical event_id as an idempotent no-op", () => {
    appendEvent(ledgerPath, prepared("1"));
    const second = appendEvent(ledgerPath, prepared("1"));
    expect(second.appended).toBe(false);
    expect(readLedger(ledgerPath)).toEqual([prepared("1")]); // still exactly one line
  });

  it("refuses a conflicting duplicate: same event_id, different content", () => {
    appendEvent(ledgerPath, prepared("1"));
    const conflicting: ReleaseEvent = { ...prepared("1"), actor: "human" };
    expect(() => appendEvent(ledgerPath, conflicting)).toThrow(
      /already exists in the ledger with different content/,
    );
    expect(readLedger(ledgerPath)).toEqual([prepared("1")]); // unchanged
  });

  it("refuses to operate on an already-corrupt ledger rather than silently extending it", () => {
    appendEvent(ledgerPath, prepared("1"));
    appendFileSync(ledgerPath, "not valid json\n");

    expect(() => readLedger(ledgerPath)).toThrow(/line 2 is not valid JSON/);

    const before = readFileSync(ledgerPath, "utf-8");
    expect(() => appendEvent(ledgerPath, prepared("2"))).toThrow();
    expect(readFileSync(ledgerPath, "utf-8")).toBe(before); // the corrupt file was left untouched, not made worse
  });
});
