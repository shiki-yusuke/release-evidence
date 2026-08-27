// Closed reason vocabulary for the F shadow evaluator (spec.md "unknown の分類"). A reason
// names WHY a predicate (or a whole evaluation) came out unknown -- orthogonal to the
// promotion-receipt/v0 contract's own `status` enum, which stays exactly
// satisfied | contradicted | unknown and is never touched here (the contract's vocabulary is
// frozen; this file only adds an internal, non-contractual "why"). Every reason is a closed
// {code, params} record -- never free prose -- so a reason can be compared/aggregated across
// replays without parsing text (sol must, "理由は {code, params} の closed record とし、現
// receipt の自由文 notes を機械 parse しない").
//
// Two separate namespaces, deliberately not unioned into one enum:
//   - UnknownReasonCode: why a predicate (or the whole evaluation) is `unknown` -- the input was
//     structurally fine, but the evidence to decide satisfied/contradicted isn't there (yet, or
//     ever, or by policy).
//   - InputErrorCode: the input itself is broken (tampered, malformed, unsupported) --
//     `evaluation_status=invalid_input`, no receipt is produced at all, and no predicate is ever
//     reached (see spec.md "入力エラーは別 namespace").
//
// This file has no fs/network/process/Date.now()/Math.random()/crypto.randomUUID() -- pure data
// shapes and constructors only (see spec.md "決定論").

import type { LaneRefOmittedCode } from "../core/types.js";

/** Closed set (spec.md): a predicate/evaluation is `unknown` for exactly one of these reasons. */
export const UNKNOWN_REASON_CODES = [
  "unknown_structural",
  "not_yet_recorded",
  "lane_ref_omitted",
  "referent_unresolved",
  "not_applicable_by_policy",
] as const;

export type UnknownReasonCode = (typeof UNKNOWN_REASON_CODES)[number];

export interface UnknownReason {
  code: UnknownReasonCode;
  params: Record<string, unknown>;
}

export function isUnknownReasonCode(value: unknown): value is UnknownReasonCode {
  return typeof value === "string" && (UNKNOWN_REASON_CODES as readonly string[]).includes(value);
}

export function unknownReason(
  code: UnknownReasonCode,
  params: Record<string, unknown> = {},
): UnknownReason {
  return { code, params };
}

/** `lane_ref_omitted` carries an EXISTING release-evidence/v0 closed code in
 * `params.omission_code` (spec.md: "params.omission_code に既存 closed code") -- it never mints
 * a new vocabulary for why a bundle omitted its lane_ref, it just points at the bundle's own
 * `LaneRefOmittedCode` (../core/types.ts). This factory pins that shape so a caller can't drift
 * into inventing a different key or a free-text note instead. */
export function laneRefOmittedReason(omissionCode: LaneRefOmittedCode): UnknownReason {
  return unknownReason("lane_ref_omitted", { omission_code: omissionCode });
}

/** Closed set (spec.md): the input itself could not be evaluated at all. */
export const INPUT_ERROR_CODES = [
  "record_invalid",
  "digest_mismatch",
  "unsupported_record_version",
] as const;

export type InputErrorCode = (typeof INPUT_ERROR_CODES)[number];

export interface InputError {
  code: InputErrorCode;
  params: Record<string, unknown>;
}

export function isInputErrorCode(value: unknown): value is InputErrorCode {
  return typeof value === "string" && (INPUT_ERROR_CODES as readonly string[]).includes(value);
}

export function inputError(code: InputErrorCode, params: Record<string, unknown> = {}): InputError {
  return { code, params };
}
