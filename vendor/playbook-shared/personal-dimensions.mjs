// Shared personal-dimension closed set, re-listed from
// docs/protocols/agent-metrics-v1.md section 7 ("Trust model"): a case-sensitive key match,
// anywhere in a nested structure, not just at the top level. That document's own rule is
// that this set may only be extended, never shrunk -- across every contract that adopts it,
// not just agent-metrics/v1 itself. Centralized here (rather than re-declared per contract)
// so every consumer scans against the exact same list by construction, and extending the
// set (if ever needed) is a one-file change instead of an N-file one.
//
// agent-metrics/v1's own verify-fixtures.mjs keeps its historical inline copy rather than
// importing this module -- that file is a frozen normative artifact and this centralization
// only touches contracts written after it (trace/v1, attribution/v1, estimate/v2).

export const FORBIDDEN_PERSONAL_DIMENSION_KEYS = new Set([
  "author",
  "reviewer",
  "assignee",
  "owner",
  "user_id",
  "username",
  "email",
  "display_name",
  "handle",
  "chat_id",
  "real_name",
]);

export function scanPersonalDimensions(value, pathStr = "") {
  const violations = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...scanPersonalDimensions(item, `${pathStr}[${i}]`)));
    return violations;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      const here = pathStr ? `${pathStr}.${key}` : key;
      if (FORBIDDEN_PERSONAL_DIMENSION_KEYS.has(key)) violations.push(here);
      violations.push(...scanPersonalDimensions(val, here));
    }
  }
  return violations;
}
