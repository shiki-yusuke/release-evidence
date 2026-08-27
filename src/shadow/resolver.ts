// Content-addressed exact-record resolver + evaluation_cut filtering (spec.md "決定論" /
// "live 化の構造的防止"). This is the ONLY file in src/shadow/** allowed to touch fs
// (spec.md: "fs は resolver の入力読み込み層だけ") -- `readRecordPoolFile` does a plain JSON
// parse and hands plain JS values to the rest of shadow core (input.ts / evaluate.ts /
// serialize.ts), none of which touch fs themselves.
//
// Resolution is BY DIGEST ONLY: a record's own digest (recomputed from its content and checked,
// never trusted) is the only lookup key. A path or record_id is never treated as "resolved"
// (spec.md "path/ID では解決しない") -- two records can legitimately share a path or record_id
// (an append-only history of a subject being reviewed twice, a bundle superseded by a later
// attempt), and picking "the current one by path" would be exactly the kind of live-state lookup
// a deterministic replay must never do. A caller that only has a path/ID, not a digest, has
// nothing to resolve against here by design.

import { readFileSync } from "node:fs";
import { validateRecordContract } from "./contracts.js";
import type { ExactRecord } from "./input.js";
import { type InputError, inputError } from "./reasons.js";
import { recordContentDigest } from "./serialize.js";
import { isRealTimestamp } from "./time.js";

export interface ResolvedRecordPool {
  /** Exact records visible at the evaluation cut: digest-verified and cut-filtered. Keyed by
   * their own (verified) digest. */
  byDigest: ReadonlyMap<string, ExactRecord>;
  /** Records present in the raw pool but excluded because their `observed_at` is after the
   * evaluation cut (spec.md: "evaluation_cut より後の event/record は読まない" -- hindsight
   * leakage is forbidden). Kept only for diagnostics/tests; `resolveByDigest` never returns one
   * of these, by construction (they are simply not in `byDigest`). */
  excludedAsFuture: readonly ExactRecord[];
  /** One entry per record whose declared `digest` did not match its recomputed content digest.
   * These records are in neither `byDigest` nor `excludedAsFuture`. Their presence means this
   * evaluation's input is untrustworthy -- callers (evaluate.ts, chunk 2) map this straight to
   * `evaluation_status=invalid_input`, never treat it as "unknown" for one predicate. */
  errors: readonly InputError[];
  /** Every record OCCURRENCE that survived cut-filtering, digest verification, envelope-conflict
   * checking, and content-contract validation -- i.e. everything that ended up backing `byDigest`,
   * but with duplicate occurrences of the same digest kept rather than collapsed to one (terra
   * round E must-1: two byte-identical `release_event` envelopes for the SAME digest -- e.g. the
   * same record pushed twice into `records[]` -- collapse to a single `byDigest` entry, which
   * silently swallowed a duplicate `event_id` the reference `foldLedger` (which folds
   * `input.records` directly, never deduplicated by digest) rejects. A caller checking
   * ledger-wide identity uniqueness must count OCCURRENCES the way the reference does, not
   * distinct digests -- this field exists for exactly that). Populated only for digest groups
   * that reached `byDigest` (a group flagged as a conflicting duplicate envelope, or whose
   * survivor failed contract validation, contributes no occurrences here either). */
  allOccurrences: readonly ExactRecord[];
}

function isAfterCut(observedAt: string, evaluationCut: string): boolean {
  // Explicit-argument Date, not the banned Date.now()/argument-less new Date() -- both inputs
  // are already-supplied ISO-8601 "Z" strings, so this is a deterministic comparison of two
  // given values, immune to the local TZ (getTime() is always UTC epoch millis) and robust to
  // differing fractional-second precision -- unlike naive string comparison, which orders
  // "...:00Z" before "...:00.5Z" for the wrong reason (an ASCII '.' sorts below 'Z').
  return new Date(observedAt).getTime() > new Date(evaluationCut).getTime();
}

/** Verifies every record's declared digest against its recomputed content digest, drops any
 * record whose `observed_at` is after `evaluationCut`, validates each survivor's content contract
 * (contracts.ts), and indexes the rest by digest. A record whose declared digest doesn't match
 * its own content is reported in `errors` and excluded from both `byDigest` and
 * `excludedAsFuture` -- a tampered record is never silently treated as "missing" (which would
 * read as `referent_unresolved`, a predicate-level unknown) or as "future" (`not_yet_recorded`);
 * it is an input error, full stop.
 *
 * Ordering follows terra review must-3 exactly ("cut後 record は内容 digest の評価前に除外する"):
 * cut-exclusion is decided from the record's OWN declared `observed_at` alone, before its content
 * digest is ever recomputed -- a future record whose content has been tampered with is simply
 * excluded, never turned into a `digest_mismatch` that would contaminate the whole evaluation with
 * `invalid_input`. `evaluationCut` itself must be a real timestamp (must-3: "日時は正規表現のみ
 * なので 2026-99-99T... も入力を通ります") -- an unreal cut makes every comparison against it
 * meaningless, so it is checked once, up front, as a synthetic input error (not tied to any one
 * record) rather than silently treating "cut can't be parsed" as "nothing is ever future".
 *
 * terra review must-4 ("同一 digest の重複 record により record 配列順で出力が変わります"):
 * digest-verified, non-future survivors are grouped by digest BEFORE insertion into `byDigest`;
 * a digest whose survivors disagree on `kind` or `observed_at` is rejected as `record_invalid` in
 * full (order-independent -- the SAME conflict is detected regardless of which record in the
 * array came first), rather than letting a plain `Map.set` silently pick whichever happened to be
 * inserted last. */
export function resolveRecordPool(
  records: readonly ExactRecord[],
  evaluationCut: string,
): ResolvedRecordPool {
  const errors: InputError[] = [];
  const excludedAsFuture: ExactRecord[] = [];

  if (!isRealTimestamp(evaluationCut)) {
    errors.push(inputError("record_invalid", { field: "evaluation_cut", value: evaluationCut }));
    return { byDigest: new Map(), excludedAsFuture, errors, allOccurrences: [] };
  }

  const survivedCut: ExactRecord[] = [];
  for (const record of records) {
    if (record.observed_at === undefined) {
      survivedCut.push(record);
      continue;
    }
    if (!isRealTimestamp(record.observed_at)) {
      errors.push(
        inputError("record_invalid", {
          kind: record.kind,
          digest: record.digest,
          field: "observed_at",
          value: record.observed_at,
        }),
      );
      continue;
    }
    if (isAfterCut(record.observed_at, evaluationCut)) {
      excludedAsFuture.push(record);
      continue;
    }
    survivedCut.push(record);
  }

  const digestVerified: ExactRecord[] = [];
  for (const record of survivedCut) {
    const recomputed = recordContentDigest(record.content);
    if (recomputed !== record.digest) {
      errors.push(
        inputError("digest_mismatch", {
          kind: record.kind,
          declared: record.digest,
          recomputed,
        }),
      );
      continue;
    }
    digestVerified.push(record);
  }

  const groupsByDigest = new Map<string, ExactRecord[]>();
  for (const record of digestVerified) {
    const group = groupsByDigest.get(record.digest);
    if (group) group.push(record);
    else groupsByDigest.set(record.digest, [record]);
  }

  const byDigest = new Map<string, ExactRecord>();
  const allOccurrences: ExactRecord[] = [];
  for (const [digest, group] of groupsByDigest) {
    const distinctKinds = new Set(group.map((r) => r.kind));
    const distinctObservedAt = new Set(group.map((r) => r.observed_at ?? ""));
    if (distinctKinds.size > 1 || distinctObservedAt.size > 1) {
      errors.push(
        inputError("record_invalid", {
          digest,
          reason: "conflicting duplicate envelopes for the same content digest",
          kinds: [...distinctKinds].sort(),
        }),
      );
      continue;
    }
    // biome-ignore lint/style/noNonNullAssertion: group is constructed non-empty above
    const survivor = group[0]!;
    const contractError = validateRecordContract(survivor);
    if (contractError) {
      errors.push(contractError);
      continue;
    }
    byDigest.set(digest, survivor);
    allOccurrences.push(...group);
  }

  return { byDigest, excludedAsFuture, errors, allOccurrences };
}

/** Resolves `digest` against `pool` -- returns `null` (never throws) when absent, so callers
 * can distinguish "no exact record for this pointer" (spec.md `referent_unresolved`) from a real
 * one, without exception-driven control flow in evaluate.ts (chunk 2). */
export function resolveByDigest(pool: ResolvedRecordPool, digest: string): ExactRecord | null {
  return pool.byDigest.get(digest) ?? null;
}

/** The one fs touch point in src/shadow/**: reads an exact-record pool file (expected to be a
 * JSON array of `ExactRecord`) off disk and parses it. Does no interpretation beyond
 * `JSON.parse` -- no digest checking (`resolveRecordPool` does that), no schema validation
 * (`input.ts` does that) -- so a malformed file surfaces as a plain `JSON.parse`/`readFileSync`
 * exception at the caller's boundary (the CLI, chunk 2), never a silent shadow-core behavior
 * change. */
export function readRecordPoolFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}
