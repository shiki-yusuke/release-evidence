import { describe, expect, it } from "vitest";
import {
  INPUT_ERROR_CODES,
  UNKNOWN_REASON_CODES,
  inputError,
  isInputErrorCode,
  isUnknownReasonCode,
  laneRefOmittedReason,
  unknownReason,
} from "../src/shadow/reasons.js";

describe("shadow reasons", () => {
  it("unknownReason produces a closed {code, params} record, params defaulting to {}", () => {
    expect(unknownReason("unknown_structural")).toEqual({
      code: "unknown_structural",
      params: {},
    });
    expect(unknownReason("referent_unresolved", { pointer: "sha256:ab" })).toEqual({
      code: "referent_unresolved",
      params: { pointer: "sha256:ab" },
    });
  });

  it("laneRefOmittedReason pins the code and nests the release-evidence closed code under omission_code", () => {
    expect(laneRefOmittedReason("legacy_release_predates_contract")).toEqual({
      code: "lane_ref_omitted",
      params: { omission_code: "legacy_release_predates_contract" },
    });
  });

  it("isUnknownReasonCode accepts exactly the closed set and rejects everything else", () => {
    for (const code of UNKNOWN_REASON_CODES) {
      expect(isUnknownReasonCode(code)).toBe(true);
    }
    expect(isUnknownReasonCode("record_invalid")).toBe(false); // input-error namespace, not this one
    expect(isUnknownReasonCode("not_a_real_code")).toBe(false);
    expect(isUnknownReasonCode(42)).toBe(false);
  });

  it("inputError produces a closed {code, params} record in the separate input-error namespace", () => {
    expect(
      inputError("digest_mismatch", { declared: "sha256:aa", recomputed: "sha256:bb" }),
    ).toEqual({
      code: "digest_mismatch",
      params: { declared: "sha256:aa", recomputed: "sha256:bb" },
    });
  });

  it("isInputErrorCode accepts exactly the closed set and rejects unknown-reason codes", () => {
    for (const code of INPUT_ERROR_CODES) {
      expect(isInputErrorCode(code)).toBe(true);
    }
    expect(isInputErrorCode("unknown_structural")).toBe(false); // unknown-reason namespace, not this one
    expect(isInputErrorCode("nope")).toBe(false);
  });
});
