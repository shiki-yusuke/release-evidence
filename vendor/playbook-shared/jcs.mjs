// Shared RFC 8785 JSON Canonicalization Scheme (minimal, sufficient for this repo's
// identity objects: nested plain objects/arrays of strings and non-negative integers, no
// floats, no non-ASCII keys) + sha256 hex helper, used by every contract in this repo to
// compute a deterministic identity hash (agent-metrics/v1's upsert_key, trace/v1's
// event_id, etc.). Extracted out of contracts/agent-metrics/v1/verify-fixtures.mjs so the
// JCS implementation exists in exactly one place -- every contract's verify script imports
// this rather than re-implementing it.
//
// Zero npm dependencies by design (see docs/protocols/agent-metrics-v1.md section 8):
// this is a JCS subset, not a general implementation, and is not meant to replace a real
// RFC 8785 library for callers with more complex inputs (floats, non-ASCII keys, etc.).

import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

export function sha256hex(bufOrStr) {
  return createHash("sha256").update(bufOrStr).digest("hex");
}
