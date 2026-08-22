// Pins this implementation against every fixture in
// contracts/release-evidence/v0/fixtures/ (owned by ai-agent-skills-playbook), via
// RELEASE_EVIDENCE_CONTRACTS_DIR. Reads expected-results.json the same way
// verify-fixtures.mjs does and reproduces its runFixture() dispatch, but calling this repo's
// own TS implementation (validateBundle / validateEvent / foldLedger / checkReleaseCollection)
// instead of the reference JS. A mismatch here means this implementation and the contract's
// reference verifier have drifted apart.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBundle } from "../src/core/bundle.js";
import { checkReleaseCollection } from "../src/core/collection.js";
import { validateEvent } from "../src/core/event.js";
import { foldLedger } from "../src/core/fold.js";
import type { Bundle, ReleaseEvent } from "../src/core/types.js";
import { CONTRACTS_DIR, HAS_CONTRACTS_DIR } from "./helpers.js";

interface FixtureEntry {
  files: string;
  type: "bundle" | "event" | "event-collection" | "release-collection";
  expected: "accept" | "reject";
  reason_code?: string;
}

interface ExpectedResults {
  fixtures: FixtureEntry[];
}

function runFixture(
  fixturesDir: string,
  entry: FixtureEntry,
): { category: "accept" | "reject"; reasons: string[] } {
  const read = <T>(file: string): T =>
    JSON.parse(readFileSync(path.join(fixturesDir, file), "utf-8")) as T;
  let problems: string[] = [];

  if (entry.type === "bundle") {
    problems = validateBundle(read<Bundle>(entry.files));
  } else if (entry.type === "event") {
    problems = validateEvent(read<ReleaseEvent>(entry.files));
  } else if (entry.type === "event-collection") {
    const events = read<ReleaseEvent[]>(entry.files);
    events.forEach((ev, i) => {
      const reasons = validateEvent(ev);
      if (reasons.length > 0)
        problems.push(`event[${i}] not individually valid: ${reasons.join("; ")}`);
    });
    if (problems.length === 0) problems.push(...foldLedger(events).problems);
  } else if (entry.type === "release-collection") {
    problems = checkReleaseCollection(
      read<{ bundles: Bundle[]; events: ReleaseEvent[] }>(entry.files),
    );
  }

  return { category: problems.length > 0 ? "reject" : "accept", reasons: problems };
}

describe.skipIf(!HAS_CONTRACTS_DIR)("release-evidence/v0 conformance", () => {
  // describe.skipIf only skips the individual tests below -- this callback body still runs
  // eagerly to register them, so reading expected-results.json must not happen when the
  // contracts dir isn't set (there would be nothing valid to read from "fixtures/...").
  const fixturesDir = path.join(CONTRACTS_DIR ?? "", "fixtures");
  const manifest: ExpectedResults = HAS_CONTRACTS_DIR
    ? (JSON.parse(
        readFileSync(path.join(fixturesDir, "expected-results.json"), "utf-8"),
      ) as ExpectedResults)
    : { fixtures: [] };

  it("expected-results.json declares every fixture on disk, and only those (drift guard)", () => {
    const declared = new Set(manifest.fixtures.map((f) => f.files));
    const onDisk = readdirSync(fixturesDir).filter(
      (f) => f.endsWith(".json") && f !== "expected-results.json",
    );
    expect(declared.size).toBe(manifest.fixtures.length); // no fixture declared twice
    expect([...onDisk].sort()).toEqual([...declared].sort());
  });

  it.each(manifest.fixtures.map((entry) => [entry.files, entry] as const))(
    "%s behaves as declared",
    (_file, entry) => {
      const result = runFixture(fixturesDir, entry);
      expect(result.category).toBe(entry.expected);
      if (entry.expected === "reject" && entry.reason_code) {
        expect(result.reasons.some((r) => r.includes(entry.reason_code as string))).toBe(true);
      }
    },
  );
});
