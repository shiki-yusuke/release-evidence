import { describe, expect, it } from "vitest";
import type { ExactRecord } from "../src/shadow/input.js";
import { resolveByDigest, resolveRecordPool } from "../src/shadow/resolver.js";
import { recordContentDigest } from "../src/shadow/serialize.js";

function record(kind: ExactRecord["kind"], content: unknown, observed_at?: string): ExactRecord {
  const digest = recordContentDigest(content);
  return observed_at ? { kind, digest, content, observed_at } : { kind, digest, content };
}

const EVALUATION_CUT = "2026-08-23T00:00:00Z";

describe("resolveRecordPool", () => {
  it("resolves a digest-verified record and makes it available via resolveByDigest", () => {
    // kind "other" carries no content contract (contracts.ts) -- this test is about the
    // resolver's generic digest-resolution mechanics, not about any one kind's content schema.
    const findingRecord = record("other", { record_id: "rf-1" });
    const pool = resolveRecordPool([findingRecord], EVALUATION_CUT);

    expect(pool.errors).toEqual([]);
    expect(pool.excludedAsFuture).toEqual([]);
    expect(resolveByDigest(pool, findingRecord.digest)).toEqual(findingRecord);
  });

  it("resolveByDigest returns null (never throws) for a digest not in the pool", () => {
    const pool = resolveRecordPool([], EVALUATION_CUT);
    expect(resolveByDigest(pool, `sha256:${"0".repeat(64)}`)).toBeNull();
  });

  it("flags a tampered record (content edited, declared digest left stale) as digest_mismatch, and excludes it from resolution", () => {
    const original = record("review_finding_record", { claim: "leaks memory" });
    const tampered: ExactRecord = { ...original, content: { claim: "leaks memory (rewritten)" } };

    const pool = resolveRecordPool([tampered], EVALUATION_CUT);

    expect(pool.errors).toHaveLength(1);
    expect(pool.errors[0]).toMatchObject({ code: "digest_mismatch" });
    expect(resolveByDigest(pool, tampered.digest)).toBeNull();
    expect(pool.excludedAsFuture).toEqual([]);
  });

  it("excludes a record observed after evaluation_cut (hindsight leakage guard), keeping it out of both byDigest and errors", () => {
    const future = record("release_event", { event_id: "ev-1" }, "2026-08-24T00:00:00Z");
    const pool = resolveRecordPool([future], EVALUATION_CUT);

    expect(pool.errors).toEqual([]);
    expect(pool.excludedAsFuture).toEqual([future]);
    expect(resolveByDigest(pool, future.digest)).toBeNull();
  });

  it("keeps a record observed exactly at evaluation_cut (boundary is inclusive, not exclusive)", () => {
    // kind "other" carries no content contract -- this test is about the cut-comparison
    // boundary, not about release_event's content schema.
    const atCut = record("other", { event_id: "ev-2" }, EVALUATION_CUT);
    const pool = resolveRecordPool([atCut], EVALUATION_CUT);

    expect(pool.excludedAsFuture).toEqual([]);
    expect(resolveByDigest(pool, atCut.digest)).toEqual(atCut);
  });

  it("compares timestamps by real time, not by string prefix (differing fractional-second precision doesn't misorder)", () => {
    // ASCII '.' sorts below 'Z', so a naive string comparison would treat "...:00.5Z" as LESS
    // THAN "...:00Z" even though 00.5s is one half-second AFTER 00s exactly -- this record must
    // still be excluded as future.
    const halfSecondAfter = record("release_event", { event_id: "ev-3" }, "2026-08-23T00:00:00.5Z");
    const pool = resolveRecordPool([halfSecondAfter], EVALUATION_CUT);
    expect(pool.excludedAsFuture).toEqual([halfSecondAfter]);
  });

  it("resolves multiple records independently, each keyed by its own digest", () => {
    // kind "policy_snapshot"/"other" carry no content contract -- this test is about per-digest
    // independence, not about any one kind's content schema.
    const firstRecord = record("policy_snapshot", { release_id: "r-1" });
    const secondRecord = record("other", { event_id: "ev-4" });
    const pool = resolveRecordPool([firstRecord, secondRecord], EVALUATION_CUT);

    expect(resolveByDigest(pool, firstRecord.digest)).toEqual(firstRecord);
    expect(resolveByDigest(pool, secondRecord.digest)).toEqual(secondRecord);
  });
});
