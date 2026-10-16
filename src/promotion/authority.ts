// Authority side: release-approval/v0 events (playbook-owned, never modified here) that a human
// places on `main` at release-approval/<repository-slug>/events.jsonl. This file only READS
// them. Their order of effect is NOT the file order on main -- it is the order in which they are
// ingested into the promotion ledger (authority_ingested events), which is the only place a
// consume decision is made.
//
// The vendored release-approval/v0 verify-fixtures.mjs exports nothing (its checks are only
// reachable through its own CLI main()), so the composite verifier cannot be called from here.
// checkApprovalEvent / checkApprovalCollection re-apply the schema plus the single-event and
// ledger-local rules that verifier enforces (R18 event_id recomputation, real calendar dates,
// expiry after occurrence, revoke resolution) -- see docs/promotion-protocol.md.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "#vendor/jcs.mjs";
import { scanPersonalDimensions } from "#vendor/personal-dimensions.mjs";
import { createValidator } from "#vendor/schema-validator.mjs";
import type { GitRunner } from "./git-cas.js";
import { type ApprovalEvent, PromotionError, isCalendarTimestamp, jcsDigest } from "./types.js";

const APPROVAL_SCHEMA_FILE = "release-approval-event.schema.json";
const APPROVAL_SCHEMA_DIR = fileURLToPath(
  new URL(".", import.meta.resolve(`#contracts/release-approval/v0/${APPROVAL_SCHEMA_FILE}`)),
);

/** The only approval subject.target a github-pages promotion consumes. The approval subject
 * carries an environment tier, not a repository: the repository binding comes from WHICH
 * authority file the event was read from (one file per repository slug). */
export const PAGES_APPROVAL_TIER = "production";

/** R18: event_id = sha256(JCS(event without event_id)). */
export function computeApprovalEventId(event: Record<string, unknown>): string {
  const { event_id: _ignored, ...rest } = event;
  return jcsDigest(rest);
}

/** Single-event checks: vendored schema + personal-dimension scan, then (only if those pass)
 * real calendar timestamps, expires_at strictly after occurred_at, and event_id recomputation. */
export function checkApprovalEvent(event: unknown): string[] {
  const { validate } = createValidator(APPROVAL_SCHEMA_DIR);
  const reasons = [
    ...validate(APPROVAL_SCHEMA_FILE, event),
    ...scanPersonalDimensions(event).map((v) => `personal_dimension_forbidden_key: ${v}`),
  ];
  if (reasons.length > 0) return [...new Set(reasons)];
  const ev = event as ApprovalEvent;
  if (!isCalendarTimestamp(ev.occurred_at)) {
    reasons.push(`invalid_calendar_timestamp: occurred_at "${ev.occurred_at}"`);
  }
  if (ev.expires_at !== undefined) {
    if (!isCalendarTimestamp(ev.expires_at)) {
      reasons.push(`invalid_calendar_timestamp: expires_at "${ev.expires_at}"`);
    } else if (Date.parse(ev.expires_at) <= Date.parse(ev.occurred_at)) {
      reasons.push(`expiry_not_after_occurrence: expires_at ${ev.expires_at} <= ${ev.occurred_at}`);
    }
  }
  const expected = computeApprovalEventId(ev as unknown as Record<string, unknown>);
  if (ev.event_id !== expected) {
    reasons.push(`event_id_mismatch: declared "${ev.event_id}", recomputed "${expected}"`);
  }
  return reasons;
}

/** Collection rules over one repository's authority file (already individually valid events). */
export function checkApprovalCollection(events: ApprovalEvent[]): string[] {
  const problems: string[] = [];
  const byId = new Map<string, ApprovalEvent>();
  for (const ev of events) {
    if (byId.has(ev.event_id)) problems.push(`duplicate_event_id: "${ev.event_id}"`);
    byId.set(ev.event_id, ev);
    if (ev.subject.target !== PAGES_APPROVAL_TIER) {
      problems.push(
        `target_mismatch: event "${ev.event_id}" subject.target "${ev.subject.target}" is not "${PAGES_APPROVAL_TIER}" (github-pages)`,
      );
    }
  }
  for (const ev of events) {
    if (ev.kind !== "approval_revoked") continue;
    const target = byId.get(ev.revoked_approval_event_id ?? "");
    if (!target) {
      problems.push(
        `revoke_target_unresolved: "${ev.event_id}" revokes "${ev.revoked_approval_event_id}", not in this target's authority file`,
      );
    } else if (target.kind !== "approval_granted" && target.kind !== "break_glass_approve") {
      problems.push(`revoke_target_wrong_kind: "${ev.event_id}" revokes a "${target.kind}"`);
    } else {
      if (canonicalize(ev.subject) !== canonicalize(target.subject)) {
        problems.push(`revoke_subject_mismatch: "${ev.event_id}"`);
      }
      if (!(Date.parse(ev.occurred_at) > Date.parse(target.occurred_at))) {
        problems.push(
          `revoke_before_grant: "${ev.event_id}" is not strictly after "${target.event_id}"`,
        );
      }
    }
  }
  return problems;
}

/** owner/repo -> "owner--repo" (GitHub owners cannot contain "--", so this is unambiguous). */
export function repositorySlug(repository: string): string {
  return repository.replace("/", "--");
}

export function authorityPath(template: string, repository: string): string {
  return template.replace("<repository-slug>", repositorySlug(repository));
}

export interface AuthorityEntry {
  line: number;
  event: ApprovalEvent;
}

export interface AuthoritySnapshot {
  commit_oid: string;
  path: string;
  entries: AuthorityEntry[];
}

/** Reads the authority file AT the main commit (git object, not the working tree, so the pin
 * recorded in authority_ingested.source is exactly what was read). The checkout must be on
 * main (HEAD == refs/heads/main) -- anything else is a usage error. A missing file is an empty
 * authority; any invalid line refuses the whole file (exit 3, nothing ingested). */
export async function readAuthority(
  git: GitRunner,
  authorityRepoDir: string,
  relPath: string,
): Promise<AuthoritySnapshot> {
  const head = (await git(["rev-parse", "--verify", "HEAD"], { cwd: authorityRepoDir })).trim();
  let main: string;
  try {
    main = (
      await git(["rev-parse", "--verify", "refs/heads/main"], { cwd: authorityRepoDir })
    ).trim();
  } catch {
    throw new PromotionError(2, `authority repo "${authorityRepoDir}" has no refs/heads/main`);
  }
  if (head !== main) {
    throw new PromotionError(
      2,
      `authority repo HEAD (${head}) is not refs/heads/main (${main}) -- authority is read from main only`,
    );
  }
  const normalized = path.posix.normalize(relPath);
  let text = "";
  try {
    text = await git(["show", `${head}:${normalized}`], { cwd: authorityRepoDir });
  } catch {
    return { commit_oid: head, path: normalized, entries: [] };
  }
  const entries: AuthorityEntry[] = [];
  const problems: string[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      problems.push(`line ${i + 1}: not valid JSON (${(err as Error).message})`);
      return;
    }
    const reasons = checkApprovalEvent(parsed);
    if (reasons.length > 0) problems.push(`line ${i + 1}: ${reasons.join("; ")}`);
    else entries.push({ line: i + 1, event: parsed as ApprovalEvent });
  });
  if (problems.length === 0) problems.push(...checkApprovalCollection(entries.map((e) => e.event)));
  if (problems.length > 0) {
    throw new PromotionError(3, `authority file ${normalized}@${head} is invalid`, { problems });
  }
  return { commit_oid: head, path: normalized, entries };
}
