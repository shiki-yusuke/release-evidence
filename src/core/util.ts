/** De-duplicates an array while preserving first-occurrence order (same behavior as the
 * `dedupe` helper in contracts/release-evidence/v0/verify-fixtures.mjs). */
export function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
