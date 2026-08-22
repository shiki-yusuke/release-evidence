// Single-event schema validation. Mirrors the `type: "event"` branch of runFixture() in
// contracts/release-evidence/v0/verify-fixtures.mjs (schemaAndScan against
// release-event.schema.json + the personal-dimension scan). Cross-event checks (the
// transition graph, duplicate event_id, dangling rollback references) live in fold.ts --
// a single event cannot see order, so this file only ever validates one record in isolation.

import { scanPersonalDimensions } from "#vendor/personal-dimensions.mjs";
import { createValidator } from "#vendor/schema-validator.mjs";
import { getContractsDir } from "./env.js";
import { dedupe } from "./util.js";

export type { ReleaseEvent } from "./types.js";

const EVENT_SCHEMA_FILE = "release-event.schema.json";

/** Validates `event` against release-event.schema.json plus the personal-dimension forbidden-
 * key scan. Returns an empty array when valid. Requires RELEASE_EVIDENCE_CONTRACTS_DIR. */
export function validateEvent(event: unknown): string[] {
  const { validate } = createValidator(getContractsDir());
  const reasons = validate(EVENT_SCHEMA_FILE, event);
  reasons.push(
    ...scanPersonalDimensions(event).map((v) => `personal_dimension_forbidden_key: ${v}`),
  );
  return dedupe(reasons);
}
