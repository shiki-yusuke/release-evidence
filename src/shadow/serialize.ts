// JCS canonical bytes + sha256 for the F shadow evaluator (spec.md "決定論" / "出力自身も
// evidence-closed"). Reuses the vendored RFC 8785 canonicalizer (#vendor/jcs.mjs) rather than
// re-implementing canonicalization -- same discipline as src/core/bundle.ts's bundleDigest.
//
// Independent digest computations live here, deliberately not merged into one helper:
//
//   - recordContentDigest(content): the content-address key resolver.ts uses to match a pointer
//     digest against an exact input record (input.ts's ExactRecord.digest).
//   - computeInputManifestDigest(refs): sha256(JCS(sorted exact record refs)) that were actually
//     consumed by one evaluation -- becomes ShadowEvaluation.input_manifest.digest.
//   - sortInputManifestRefs(refs): the same (kind, digest) sort computeInputManifestDigest uses
//     internally, exposed so evaluate.ts (chunk 2) can embed input_manifest.records in that same
//     order -- JCS canonicalizes object KEYS only, never array order (bundle.ts's own comment:
//     "array order is preserved and so remains normative"), so the wrapper's embedded records
//     array must be sorted explicitly by the caller, not left to canonicalize() to fix.
//   - computeSemanticDigest(receipt): promotion-receipt/v0's own R12 semantic_digest -- sha256(JCS
//     (receipt with evaluated_at, receipt_id, and semantic_digest itself removed)). Same
//     "strip self (and time), then hash the rest" pattern as computeRecordDigest below, but
//     stripping three fields instead of one because R12 deliberately excludes time from identity
//     (see docs/protocols/promotion-receipt-v0.md "what TOCTOU actually compares").
//   - deriveReceiptId(parts): spec.md "決定論" -- receipt_id is input manifest digest + evaluator
//     version + phase, never crypto.randomUUID() (banned in shadow core).
//   - computeRecordDigest(record): sha256(JCS(record with its own `record_digest` field
//     removed)) -- becomes ShadowEvaluation.record_digest, the wrapper's own self-digest.
//
// No Date.now() / argument-less new Date() / Math.random() / crypto.randomUUID() / process.env /
// fs / network here -- see docs/spec/I-2026-08-27-f-shadow-evaluator/spec.md "決定論". Sorting
// below uses plain `<`/`>` string comparison (UTF-16 code unit order), never
// `localeCompare` -- collation is locale-dependent and the determinism test runs the same input
// under different locales expecting byte-identical output (spec.md "決定論": "TZ / locale / key
// order / record order を変えて cmp").

import { canonicalize, sha256hex } from "#vendor/jcs.mjs";
import type { InputError } from "./reasons.js";

/** sha256 of the JCS canonical bytes of `content` -- the content-address key for one exact
 * record. Stable for any two calls with the same content regardless of key order. */
export function recordContentDigest(content: unknown): string {
  return `sha256:${sha256hex(canonicalize(content))}`;
}

export interface InputManifestRef {
  kind: string;
  digest: string;
}

function compareRefs(a: InputManifestRef, b: InputManifestRef): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.digest === b.digest) return 0;
  return a.digest < b.digest ? -1 : 1;
}

/** sha256(JCS(sorted exact record refs)) -- refs are sorted by (kind, digest) first, so the
 * order records happened to arrive in (filesystem read order, array order in the input) never
 * perturbs the digest; only the SET of records actually consumed does. */
export function computeInputManifestDigest(refs: readonly InputManifestRef[]): string {
  const sorted = [...refs].sort(compareRefs);
  return `sha256:${sha256hex(canonicalize(sorted))}`;
}

/** The same (kind, digest) order computeInputManifestDigest sorts by internally, exposed for
 * evaluate.ts to embed `ShadowEvaluation.input_manifest.records` in -- see this file's header
 * comment for why JCS alone cannot make that array order-independent. */
export function sortInputManifestRefs<T extends InputManifestRef>(refs: readonly T[]): T[] {
  return [...refs].sort(compareRefs);
}

/** promotion-receipt/v0 R12: sha256(JCS(receipt)) with `evaluated_at`, `receipt_id`, and
 * `semantic_digest` itself removed first. Does not mutate `receipt`. Time is deliberately
 * excluded (docs/protocols/promotion-receipt-v0.md "what TOCTOU actually compares") -- a change
 * to WHEN a receipt was evaluated must never itself change this digest, only a change to WHAT it
 * found. */
export function computeSemanticDigest(receipt: Record<string, unknown>): string {
  const {
    evaluated_at: _evaluatedAt,
    receipt_id: _receiptId,
    semantic_digest: _semanticDigest,
    ...rest
  } = receipt;
  return `sha256:${sha256hex(canonicalize(rest))}`;
}

export interface ReceiptIdParts {
  inputManifestDigest: string;
  evaluatorVersion: string;
  phase: string;
}

/** Deterministic `receipt_id`: derived from the input manifest digest, evaluator version, and
 * evaluation phase (spec.md "決定論" -- never crypto.randomUUID(), which is banned in shadow
 * core). The same three inputs always derive the same id, so re-running the same replay is
 * idempotent rather than minting a fresh identity each time. */
export function deriveReceiptId(parts: ReceiptIdParts): string {
  return `sha256:${sha256hex(canonicalize([parts.inputManifestDigest, parts.evaluatorVersion, parts.phase]))}`;
}

/** sha256(JCS(record)) with `record_digest` itself removed first -- the wrapper's own
 * self-digest. Does not mutate `record`. A caller that changes any field OTHER than
 * `record_digest` and recomputes will get a different digest; changing `record_digest` alone
 * (e.g. an attacker copying an old value onto edited content) does not, by construction, since
 * the field is excluded from the hashed bytes -- this is exactly what lets a verifier recompute
 * and compare instead of trusting the stored value. */
export function computeRecordDigest(record: Record<string, unknown>): string {
  const { record_digest: _recordDigest, ...withoutDigest } = record;
  return `sha256:${sha256hex(canonicalize(withoutDigest))}`;
}

/** Closed sort key for `ShadowEvaluation.input_errors` (terra review round C, must-4 residual:
 * "独立した invalid record 2件を反転すると input_errors の順序が反転し、record_digest と出力
 * bytes が変わりました。エラーが入力順のまま蓄積されています" -- `record_digest` hashes the
 * WHOLE wrapper via JCS, which canonicalizes object KEYS but never array order (this file's own
 * header comment), so `input_errors` must be sorted explicitly before it is ever embedded, the
 * same discipline `sortInputManifestRefs` already applies to `input_manifest.records`).
 *
 * Key order: `code` (the closed InputErrorCode), then the record identifier the error is about
 * (`params.digest`, falling back to `params.declared` -- `digest_mismatch`'s own param name for
 * the record's declared digest -- then "" when the error names no single record, e.g. an invalid
 * `evaluation_cut`), then `params.field`/`params.kind` (whichever names WHERE within that record
 * the problem is), then the full JCS canonical bytes of `params` itself as a final, total
 * tiebreaker -- two errors that agree on all three of the above but differ in, say, `errors: []`
 * content (a nested list of schema/semantic-check messages) must still sort deterministically
 * rather than falling back to array-position (which is exactly the non-determinism this exists to
 * remove). */
function inputErrorSortKey(error: InputError): readonly [string, string, string, string] {
  const params = error.params;
  const digest =
    typeof params.digest === "string"
      ? params.digest
      : typeof params.declared === "string"
        ? params.declared
        : "";
  const locator =
    typeof params.field === "string"
      ? params.field
      : typeof params.kind === "string"
        ? params.kind
        : "";
  return [error.code, digest, locator, canonicalize(params)];
}

function compareInputErrors(a: InputError, b: InputError): number {
  const ka = inputErrorSortKey(a);
  const kb = inputErrorSortKey(b);
  for (let i = 0; i < ka.length; i++) {
    const av = ka[i] as string;
    const bv = kb[i] as string;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/** Sorts `errors` by `inputErrorSortKey` -- byte-identical `input_errors`/`record_digest` output
 * regardless of which order the underlying records happened to arrive in (spec.md "決定論":
 * "record 順を変えても...cmp"). */
export function sortInputErrors(errors: readonly InputError[]): InputError[] {
  return [...errors].sort(compareInputErrors);
}

/** The wrapper's final wire format: JCS canonical bytes + a single trailing LF (spec.md
 * "決定論": "出力は JCS canonical bytes + LF"). `evaluation` must already carry its real
 * `record_digest` (computeRecordDigest's output) -- this function only serializes, it never
 * computes or embeds a digest itself. Used by both the CLI (stdout/--out) and the determinism
 * test (two-process byte comparison) so both consume the exact same code path. */
export function serializeShadowEvaluation(evaluation: unknown): Buffer {
  return Buffer.from(`${canonicalize(evaluation)}\n`, "utf-8");
}
