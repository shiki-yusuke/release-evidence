// promotion.config.json: closed shape, every key required. The ledger ref is fixed (no CLI flag
// can point a write at another ref), and ledger_path must be a single top-level file name
// because every ledger commit's tree contains exactly that one file.

import { readFileSync } from "node:fs";
import { PromotionError } from "./types.js";

export const LEDGER_REF = "refs/heads/promotion-ledger";

export interface PromotionConfig {
  remote_url: string;
  ref: typeof LEDGER_REF;
  ledger_path: string;
  authority_path_template: string;
  expiry_safety_window_s: number;
  settle_window_s: number;
  reconcile_lookback_s: number;
  max_cas_retries: number;
}

const INTEGER_KEYS = [
  "expiry_safety_window_s",
  "settle_window_s",
  "reconcile_lookback_s",
  "max_cas_retries",
] as const;
const KEYS = ["remote_url", "ref", "ledger_path", "authority_path_template", ...INTEGER_KEYS];

export function parseConfig(value: unknown): PromotionConfig {
  const problems: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PromotionError(2, "promotion config must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!KEYS.includes(key)) problems.push(`unknown key ${key}`);
  for (const key of KEYS) if (!(key in obj)) problems.push(`missing key ${key}`);
  if (typeof obj.remote_url !== "string" || obj.remote_url.length === 0) {
    problems.push("remote_url must be a non-empty string");
  }
  if (obj.ref !== LEDGER_REF) problems.push(`ref must be "${LEDGER_REF}"`);
  if (
    typeof obj.ledger_path !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(obj.ledger_path)
  ) {
    problems.push("ledger_path must be a single top-level file name");
  }
  const template = obj.authority_path_template;
  if (
    typeof template !== "string" ||
    !template.includes("<repository-slug>") ||
    template.startsWith("/") ||
    template.split("/").some((seg) => seg === ".." || seg === ".")
  ) {
    problems.push("authority_path_template must be a relative path containing <repository-slug>");
  }
  for (const key of INTEGER_KEYS) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      problems.push(`${key} must be a non-negative integer`);
    }
  }
  if (obj.max_cas_retries === 0) problems.push("max_cas_retries must be >= 1");
  if (problems.length > 0) {
    throw new PromotionError(2, `invalid promotion config: ${problems.join("; ")}`);
  }
  return obj as unknown as PromotionConfig;
}

export function loadConfig(configPath: string): PromotionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new PromotionError(2, `cannot read config ${configPath}: ${(err as Error).message}`);
  }
  return parseConfig(parsed);
}
