import { describe, expect, it } from "vitest";
import type { InputError } from "../src/shadow/reasons.js";
import {
  computeInputManifestDigest,
  computeRecordDigest,
  recordContentDigest,
  sortInputErrors,
} from "../src/shadow/serialize.js";

describe("shadow serialize digests", () => {
  it("recordContentDigest is stable across key order (JCS canonicalization)", () => {
    const a = { kind: "release_event", digest: "sha256:aa" };
    const b = { digest: "sha256:aa", kind: "release_event" };
    expect(recordContentDigest(a)).toBe(recordContentDigest(b));
  });

  it("recordContentDigest changes when content changes", () => {
    const a = recordContentDigest({ claim: "leaks memory" });
    const b = recordContentDigest({ claim: "leaks memory (fixed)" });
    expect(a).not.toBe(b);
  });

  it("recordContentDigest returns the sha256:<hex> shape", () => {
    expect(recordContentDigest({ x: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("computeInputManifestDigest is independent of array order (sorted before hashing)", () => {
    const refs = [
      { kind: "release_event", digest: "sha256:bb" },
      { kind: "release_evidence_bundle", digest: "sha256:aa" },
    ];
    const reversed = [...refs].reverse();
    expect(computeInputManifestDigest(refs)).toBe(computeInputManifestDigest(reversed));
  });

  it("computeInputManifestDigest changes when the ref set changes", () => {
    const a = computeInputManifestDigest([{ kind: "release_event", digest: "sha256:aa" }]);
    const b = computeInputManifestDigest([{ kind: "release_event", digest: "sha256:bb" }]);
    expect(a).not.toBe(b);
  });

  it("computeRecordDigest excludes record_digest itself from the hashed bytes", () => {
    const withoutSelfDigest = { schema_version: "shadow-evaluation/v0", mode: "shadow_only" };
    const withPlaceholder = { ...withoutSelfDigest, record_digest: "sha256:placeholder" };
    const withDifferentPlaceholder = { ...withoutSelfDigest, record_digest: "sha256:other" };
    const expected = computeRecordDigest(withoutSelfDigest);
    expect(computeRecordDigest(withPlaceholder)).toBe(expected);
    expect(computeRecordDigest(withDifferentPlaceholder)).toBe(expected);
  });

  it("computeRecordDigest detects tampering in any field other than record_digest", () => {
    const original = { evaluation_status: "evaluated" as string, record_digest: "sha256:x" };
    const tampered = { evaluation_status: "unknown" as string, record_digest: "sha256:x" };
    expect(computeRecordDigest(original)).not.toBe(computeRecordDigest(tampered));
  });

  it("does not mutate the record passed to computeRecordDigest", () => {
    const record = { a: 1, record_digest: "sha256:x" };
    const before = JSON.stringify(record);
    computeRecordDigest(record);
    expect(JSON.stringify(record)).toBe(before);
  });
});

describe("sortInputErrors (terra review round C, must-4 residual)", () => {
  it("sorts by code first", () => {
    const a: InputError = { code: "unsupported_record_version", params: {} };
    const b: InputError = { code: "digest_mismatch", params: {} };
    expect(sortInputErrors([a, b])).toEqual([b, a]);
    expect(sortInputErrors([b, a])).toEqual([b, a]);
  });

  it("within the same code, sorts by the record's digest (falling back to `declared` for digest_mismatch)", () => {
    const a: InputError = { code: "record_invalid", params: { digest: "sha256:bb" } };
    const b: InputError = { code: "record_invalid", params: { digest: "sha256:aa" } };
    expect(sortInputErrors([a, b])).toEqual([b, a]);
    expect(sortInputErrors([b, a])).toEqual([b, a]);
  });

  it("two errors that agree on code and digest still sort deterministically by their full params content, regardless of array order", () => {
    const a: InputError = {
      code: "record_invalid",
      params: { digest: "sha256:aa", errors: ["z_first_alphabetically_would_be_wrong_to_assume"] },
    };
    const b: InputError = {
      code: "record_invalid",
      params: { digest: "sha256:aa", errors: ["a_different_error"] },
    };
    const forward = sortInputErrors([a, b]);
    const reversed = sortInputErrors([b, a]);
    expect(forward).toEqual(reversed);
  });

  it("an evaluation_cut error (no digest/declared param at all) sorts using its own field name, never throwing on missing digest", () => {
    const cutError: InputError = {
      code: "record_invalid",
      params: { field: "evaluation_cut", value: "2026-99-99T00:00:00Z" },
    };
    const digestError: InputError = {
      code: "record_invalid",
      params: { digest: "sha256:aa" },
    };
    expect(() => sortInputErrors([cutError, digestError])).not.toThrow();
    expect(sortInputErrors([cutError, digestError])).toEqual(
      sortInputErrors([digestError, cutError]),
    );
  });

  it("does not mutate the array passed in", () => {
    const errors: InputError[] = [
      { code: "unsupported_record_version", params: {} },
      { code: "digest_mismatch", params: {} },
    ];
    const before = [...errors];
    sortInputErrors(errors);
    expect(errors).toEqual(before);
  });
});
