// Real-calendar timestamp validation (spec.md "決定論" / terra review must-3: "日時は正規表現の
// みなので 2026-99-99T... も入力を通ります" -- TIMESTAMP_PATTERN only checks digit SHAPE, never
// calendar validity). Every ISO-8601 "Z" timestamp this evaluator trusts (evaluation_cut, a
// record's observed_at) must pass isRealTimestamp in addition to TIMESTAMP_PATTERN -- computed by
// hand from the regex capture groups, never by asking `new Date()` to parse and hoping it rejects
// overflow: the built-in parser silently rolls "2026-02-30" forward into March instead of
// rejecting it, so range-checking has to be done on the captured digits directly.
//
// Pure -- no fs/network/process.env/Date.now()/argument-less new Date() (spec.md "決定論").

export const TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$";

const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** True when `value` matches TIMESTAMP_PATTERN AND names a real calendar date/time (month 1-12,
 * day valid for that month/year, hour 0-23, minute/second 0-59). Never delegates the range check
 * to `new Date()` -- see this file's header comment for why that would accept overflow. */
export function isRealTimestamp(value: string): boolean {
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  if (day < 1 || day > maxDay) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return true;
}
