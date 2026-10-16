// Promotion ledger fold. The ledger is NOT authority: it only records, in append order, which
// authority event (release-approval/v0) was consumed by which promotion and what the provider
// said happened. Current state is always derived here, never stored. Order of effect = order of
// lines in the ledger (= order of fast-forward commits on the promotion-ledger ref).
//
// Per promotion (promotion_id = source run_id + run_attempt), exactly three paths are legal:
//   normal:      authorized(approval_granted|break_glass w/o external effect) -> effect_send
//                -> effect_requested -> terminal(operation_completed, same deployment_id)
//   unknown:     authorized -> effect_send -> [effect_requested(deployment_id null)]
//                -> terminal(abandoned_no_effect | operation_completed via reconcile)
//   break_glass: authorized(external_effect) -> terminal(operation_completed,
//                deployment_id == external_effect.deployment_id); no effect_send/effect_requested
// Anything else is a problem, and a ledger with any problem refuses every write.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, sha256hex } from "#vendor/jcs.mjs";
import { createValidator } from "#vendor/schema-validator.mjs";
import { checkApprovalEvent } from "./authority.js";
import {
  type ApprovalEvent,
  type AuthorizedEvent,
  type EffectRequestedEvent,
  type EffectSendEvent,
  type LateEffectDetectedEvent,
  type LateEffectResolvedEvent,
  PROMOTION_SCHEMA_VERSION,
  type PromotionEvent,
  type PromotionEventDraft,
  type PromotionId,
  type PromotionTarget,
  type RevokedAfterConsumeEvent,
  TERMINAL_OUTCOME,
  type TerminalEvent,
  canonicalTarget,
  isCalendarTimestamp,
  jcsDigest,
  promotionKey,
} from "./types.js";

const SCHEMA_FILE = "promotion-event.schema.json";

/** The schema lives in src/promotion/schema/ (tsc does not copy JSON into dist/), so the
 * compiled dist/src/promotion/fold.js looks for it back in the source tree. */
function schemaDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "schema"),
    path.resolve(here, "..", "..", "..", "src", "promotion", "schema"),
  ];
  const found = candidates.find((dir) => existsSync(path.join(dir, SCHEMA_FILE)));
  if (!found) throw new Error(`cannot locate ${SCHEMA_FILE} (looked in ${candidates.join(", ")})`);
  return found;
}

let validator: ReturnType<typeof createValidator> | undefined;

function collectTimestamps(value: unknown, at: string, out: Array<[string, unknown]>): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const here = `${at}.${key}`;
    if (key === "authority_event") continue; // validated by its own contract checks
    if (key.endsWith("_at") || key === "created_at_not_before") {
      if (child !== null) out.push([here, child]);
    } else {
      collectTimestamps(child, here, out);
    }
  }
}

/** Schema + real-calendar timestamps + (authority_ingested) the carried approval event. */
export function validatePromotionEvent(event: unknown): string[] {
  validator ??= createValidator(schemaDir());
  const reasons = validator.validate(SCHEMA_FILE, event);
  if (reasons.length > 0) return reasons;
  const stamps: Array<[string, unknown]> = [];
  collectTimestamps(event, "$", stamps);
  for (const [at, value] of stamps) {
    if (!isCalendarTimestamp(value))
      reasons.push(`${at}: "${String(value)}" is not a real UTC date`);
  }
  const ev = event as PromotionEvent;
  if (ev.kind === "authority_ingested") {
    reasons.push(...checkApprovalEvent(ev.authority_event).map((r) => `authority_event: ${r}`));
  }
  return reasons;
}

/** Completes a draft into a ledger line. event_id is derived from the content (so a retried
 * build of the same facts is the same id) and fits the schema's `^[a-z0-9-]{8,64}$`. With a
 * `nonce` (the CAS call's, used for effect_send) the id also covers it, so two processes that
 * build the same facts get different ids and each can tell whether the line is its own. */
export function buildEvent(
  draft: PromotionEventDraft,
  target: PromotionTarget,
  occurredAt: string,
  nonce?: string,
): PromotionEvent {
  const body = {
    schema_version: PROMOTION_SCHEMA_VERSION,
    ...draft,
    target,
    occurred_at: occurredAt,
    actor: "ci" as const,
  };
  return {
    ...body,
    event_id: `pe-${sha256hex(nonce ? `${canonicalize(body)}\n${nonce}` : canonicalize(body)).slice(0, 40)}`,
  } as PromotionEvent;
}

export type PromotionPhase = "authorized" | "sent" | "requested" | "terminal";

export interface PromotionState {
  promotion_id: PromotionId;
  phase: PromotionPhase;
  authorized: AuthorizedEvent;
  effectSend: EffectSendEvent | null;
  effectRequested: EffectRequestedEvent | null;
  terminal: TerminalEvent | null;
  revokedAfterConsume: RevokedAfterConsumeEvent[];
}

export interface IngestedApproval {
  event: ApprovalEvent;
  ingest_event_id: string;
}

export interface LateEffectState {
  detected: LateEffectDetectedEvent;
  resolved: LateEffectResolvedEvent | null;
}

export interface TargetState {
  target: PromotionTarget;
  promotions: Map<string, PromotionState>;
  consumedApprovalIds: Set<string>;
  /** Ingested authority events by approval event_id, in ledger order. */
  authority: Map<string, IngestedApproval>;
  /** revoked approval event_id -> revoke event_id (ingested). */
  revokes: Map<string, string>;
  lateEffects: Map<string, LateEffectState>;
  pendingLateEffects: Array<{
    event_id: string;
    deployment_id: string;
    matched_promotion_id: PromotionId | null;
  }>;
  locked: boolean;
  lockReasons: string[];
}

export interface PromotionFoldResult {
  targets: Map<string, TargetState>;
  problems: string[];
  /** approval event_id -> "<canonical target> <promotion key>" across the WHOLE ledger. */
  approvalConsumers: Map<string, string>;
  /** deployment id -> its single owner across the WHOLE ledger: "<canonical target> <promotion
   * key>" (effect_requested / terminal / external_effect / attributed late effect) or
   * "<canonical target> late:<event id>" (a late effect matched to no promotion). */
  deploymentOwners: Map<string, string>;
}

function emptyTarget(target: PromotionTarget): TargetState {
  return {
    target,
    promotions: new Map(),
    consumedApprovalIds: new Set(),
    authority: new Map(),
    revokes: new Map(),
    lateEffects: new Map(),
    pendingLateEffects: [],
    locked: false,
    lockReasons: [],
  };
}

/** Lock reasons for a target, optionally ignoring one promotion (the one being advanced). */
export function lockReasonsOf(state: TargetState, excludeKey?: string): string[] {
  const reasons: string[] = [];
  for (const [key, p] of state.promotions) {
    if (p.phase !== "terminal" && key !== excludeKey) reasons.push(`open_promotion:${key}`);
  }
  for (const [id, le] of state.lateEffects) {
    if (!le.resolved) reasons.push(`pending_late_effect:${id}:${le.detected.deployment_id}`);
  }
  return reasons;
}

const same = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);

function checkAuthorized(
  ev: AuthorizedEvent,
  state: TargetState,
  consumers: Map<string, string>,
): string[] {
  const p: string[] = [];
  const key = promotionKey(ev.promotion_id);
  if (state.promotions.has(key)) p.push(`duplicate_promotion: ${key} already authorized`);
  const consumer = consumers.get(ev.approval_event_id);
  if (consumer) p.push(`approval_already_consumed: ${ev.approval_event_id} by ${consumer}`);
  const ingested = state.authority.get(ev.approval_event_id);
  if (!ingested) {
    p.push(`approval_not_ingested: ${ev.approval_event_id} not ingested for this target`);
    return p;
  }
  const approval = ingested.event;
  if (approval.kind !== ev.approval_kind) {
    p.push(
      `approval_kind_mismatch: ledger says ${ev.approval_kind}, authority says ${approval.kind}`,
    );
  }
  if (state.revokes.has(ev.approval_event_id)) {
    p.push(`approval_revoked_before_consume: ${ev.approval_event_id}`);
  }
  if (!same(ev.subject, approval.subject)) p.push("subject_mismatch: subject != authority subject");
  if (ev.subject_digest !== jcsDigest(approval.subject)) p.push("subject_digest_mismatch");
  if (ev.expires_at !== approval.expires_at) p.push("expires_at_mismatch");
  if (ev.recorded_after_side_effect !== (approval.recorded_after_side_effect === true)) {
    p.push("recorded_after_side_effect_mismatch");
  }
  if (ev.resolved.bundle_digest !== approval.subject.bundle_digest)
    p.push("bundle_digest_mismatch");
  if (ev.resolved.receipt_digest !== approval.subject.receipt_digest) {
    p.push("receipt_digest_mismatch");
  }
  const { receipt_promotion_id: rid, derived_promotion_id: did } = ev.resolved;
  if ((rid === null) === (did === null)) {
    p.push(
      "promotion_id_attribution: exactly one of receipt_promotion_id / derived_promotion_id must be set",
    );
  } else if (rid !== null && !same(rid, ev.promotion_id)) {
    p.push("receipt_promotion_id_mismatch");
  } else if (
    did !== null &&
    (did.run_id !== ev.promotion_id.run_id || did.run_attempt !== ev.promotion_id.run_attempt)
  ) {
    p.push("derived_promotion_id_mismatch");
  }
  const run = ev.resolved.source_run;
  if (run.run_id !== ev.promotion_id.run_id || run.run_attempt !== ev.promotion_id.run_attempt) {
    p.push("source_run_mismatch: source_run != promotion_id");
  }
  const expectedName = `site-dist-${run.run_id}-${run.run_attempt}`;
  if (ev.resolved.source_artifact.name !== expectedName) {
    p.push(`source_artifact_name_mismatch: expected ${expectedName}`);
  }
  const evidenceName = `release-evidence-out-${run.run_id}-${run.run_attempt}`;
  if (ev.resolved.source_artifact.evidence_artifact.name !== evidenceName) {
    p.push(`evidence_artifact_name_mismatch: expected ${evidenceName}`);
  }
  const margin = (Date.parse(ev.expires_at) - Date.parse(ev.evaluated_at)) / 1000;
  if (!(margin > ev.expiry_safety_window_s)) {
    p.push(
      `expiry_window_violated: expires_at - evaluated_at = ${margin}s <= ${ev.expiry_safety_window_s}s`,
    );
  }
  if (ev.external_effect && ev.external_effect.sha !== run.head_sha) {
    p.push("external_effect_sha_mismatch: external effect sha != source head_sha");
  }
  for (const r of lockReasonsOf(state)) p.push(`target_locked: ${r}`);
  return p;
}

function checkTerminal(ev: TerminalEvent, pr: PromotionState): string[] {
  const p: string[] = [];
  if (pr.phase === "terminal") return ["already_terminal"];
  if (ev.operation_completed) {
    const expected = TERMINAL_OUTCOME[ev.operation_completed.state];
    if (expected !== ev.outcome)
      p.push(`outcome_mismatch: ${ev.operation_completed.state} -> ${expected}`);
  }
  const completed = ev.resolution === "operation_completed";
  const external = pr.authorized.external_effect;
  switch (pr.phase) {
    case "authorized":
      if (!external) return [...p, "terminal_without_effect_send"];
      if (!completed || ev.deployment_id !== external.deployment_id) {
        p.push("break_glass_terminal_mismatch: must be operation_completed on external deployment");
      }
      break;
    case "sent":
      if (completed && ev.via !== "reconcile") p.push("unknown_deployment_requires_reconcile");
      break;
    case "requested": {
      const requestedId = pr.effectRequested?.deployment_id ?? null;
      if (requestedId !== null) {
        if (!completed) p.push("abandon_with_known_deployment");
        else if (ev.deployment_id !== requestedId) p.push("terminal_deployment_id_mismatch");
      } else if (completed && ev.via !== "reconcile") {
        p.push("unknown_deployment_requires_reconcile");
      }
      break;
    }
  }
  if (ev.reconcile && ev.reconcile.criteria.sha !== pr.authorized.resolved.source_run.head_sha) {
    p.push("reconcile_criteria_sha_mismatch");
  }
  return p;
}

/** Folds the whole ledger. Events that produce a problem are reported and NOT applied. */
export function foldPromotionLedger(events: unknown[]): PromotionFoldResult {
  const problems: string[] = [];
  const targets = new Map<string, TargetState>();
  const approvalConsumers = new Map<string, string>();
  const deploymentOwners = new Map<string, string>();
  const ingestedAnywhere = new Set<string>();
  const seenIds = new Set<string>();

  events.forEach((raw, idx) => {
    const line = idx + 1;
    const reasons = validatePromotionEvent(raw);
    if (reasons.length > 0) {
      problems.push(`line ${line}: schema: ${reasons.join("; ")}`);
      return;
    }
    const ev = raw as PromotionEvent;
    const bad = (msg: string) => problems.push(`line ${line} (${ev.kind} ${ev.event_id}): ${msg}`);
    if (seenIds.has(ev.event_id)) {
      bad("duplicate_event_id");
      return;
    }
    seenIds.add(ev.event_id);
    const tkey = canonicalTarget(ev.target);
    let state = targets.get(tkey);
    if (!state) {
      state = emptyTarget(ev.target);
      targets.set(tkey, state);
    }
    const promotion =
      "promotion_id" in ev && ev.kind !== "revoked_after_consume"
        ? state.promotions.get(promotionKey(ev.promotion_id))
        : undefined;
    // A deployment belongs to at most one promotion ledger-wide: any event that would tie a
    // deployment already recorded for another owner to this promotion is refused.
    const ownerOf = (id: PromotionId) => `${tkey} ${promotionKey(id)}`;
    const claimedElsewhere = (deploymentId: string | null, owner: string): string | null => {
      if (deploymentId === null) return null;
      const current = deploymentOwners.get(deploymentId);
      return current !== undefined && current !== owner
        ? `deployment_attributed_elsewhere: ${deploymentId} is recorded for ${current}`
        : null;
    };

    switch (ev.kind) {
      case "authority_ingested": {
        const a = ev.authority_event;
        if (ingestedAnywhere.has(a.event_id))
          return bad(`authority_already_ingested: ${a.event_id}`);
        if (a.kind === "approval_revoked") {
          const revoked = a.revoked_approval_event_id ?? "";
          if (!state.authority.has(revoked)) {
            return bad(`revoke_target_not_ingested: ${revoked}`);
          }
          state.revokes.set(revoked, a.event_id);
        }
        ingestedAnywhere.add(a.event_id);
        state.authority.set(a.event_id, { event: a, ingest_event_id: ev.event_id });
        return;
      }
      case "authorized": {
        const p = checkAuthorized(ev, state, approvalConsumers);
        const claim = claimedElsewhere(
          ev.external_effect?.deployment_id ?? null,
          ownerOf(ev.promotion_id),
        );
        if (claim) p.push(claim);
        if (p.length > 0) return bad(p.join("; "));
        if (ev.external_effect) {
          deploymentOwners.set(ev.external_effect.deployment_id, ownerOf(ev.promotion_id));
        }
        const key = promotionKey(ev.promotion_id);
        state.promotions.set(key, {
          promotion_id: ev.promotion_id,
          phase: "authorized",
          authorized: ev,
          effectSend: null,
          effectRequested: null,
          terminal: null,
          revokedAfterConsume: [],
        });
        state.consumedApprovalIds.add(ev.approval_event_id);
        approvalConsumers.set(ev.approval_event_id, `${tkey} ${key}`);
        return;
      }
      case "effect_send": {
        if (!promotion) return bad("effect_send_without_authorized");
        if (promotion.phase !== "authorized") return bad(`effect_send_from_${promotion.phase}`);
        const auth = promotion.authorized;
        if (auth.external_effect) return bad("effect_send_on_break_glass_external_effect");
        const p: string[] = [];
        if (ev.bundle_digest !== auth.resolved.bundle_digest) p.push("bundle_digest_mismatch");
        if (!same(ev.source_artifact, auth.resolved.source_artifact)) {
          p.push("source_artifact_mismatch");
        }
        const pbv = `${auth.resolved.source_run.head_sha}:${ev.promotion_id.run_id}:${ev.promotion_id.run_attempt}`;
        if (ev.pages_build_version !== pbv) p.push(`pages_build_version_mismatch: expected ${pbv}`);
        if (
          ev.pages_artifact.content_manifest_digest !==
          auth.resolved.source_artifact.content_manifest_digest
        ) {
          p.push("pages_artifact_content_mismatch: != authorized content_manifest_digest");
        }
        const pagesName = `github-pages-${auth.executor.run_id}-${auth.executor.run_attempt}`;
        if (ev.pages_artifact.name !== pagesName) {
          p.push(`pages_artifact_name_mismatch: expected ${pagesName}`);
        }
        for (const r of lockReasonsOf(state, promotionKey(ev.promotion_id))) {
          p.push(`target_locked: ${r}`);
        }
        if (p.length > 0) return bad(p.join("; "));
        promotion.effectSend = ev;
        promotion.phase = "sent";
        return;
      }
      case "effect_requested": {
        if (!promotion) return bad("effect_requested_without_authorized");
        if (promotion.phase !== "sent") return bad(`effect_requested_from_${promotion.phase}`);
        if (ev.request_fingerprint !== promotion.effectSend?.request_fingerprint) {
          return bad("request_fingerprint_mismatch");
        }
        const claim = claimedElsewhere(ev.deployment_id, ownerOf(ev.promotion_id));
        if (claim) return bad(claim);
        if (ev.deployment_id !== null) {
          deploymentOwners.set(ev.deployment_id, ownerOf(ev.promotion_id));
        }
        promotion.effectRequested = ev;
        promotion.phase = "requested";
        return;
      }
      case "terminal": {
        if (!promotion) return bad("terminal_without_authorized");
        const p = checkTerminal(ev, promotion);
        const claim = claimedElsewhere(ev.deployment_id, ownerOf(ev.promotion_id));
        if (claim) p.push(claim);
        if (p.length > 0) return bad(p.join("; "));
        if (ev.deployment_id !== null) {
          deploymentOwners.set(ev.deployment_id, ownerOf(ev.promotion_id));
        }
        promotion.terminal = ev;
        promotion.phase = "terminal";
        return;
      }
      case "revoked_after_consume": {
        const pr = state.promotions.get(promotionKey(ev.promotion_id));
        if (!pr || pr.authorized.approval_event_id !== ev.approval_event_id) {
          return bad("revoked_after_consume_unknown_consumption");
        }
        if (state.revokes.get(ev.approval_event_id) !== ev.revoke_event_id) {
          return bad("revoked_after_consume_revoke_not_ingested");
        }
        if (pr.revokedAfterConsume.some((r) => r.revoke_event_id === ev.revoke_event_id)) {
          return bad("revoked_after_consume_duplicate");
        }
        pr.revokedAfterConsume.push(ev);
        return;
      }
      case "late_effect_detected": {
        // A late effect is a deployment no promotion has recorded. matched_promotion_id (set
        // only from an exact pages_build_version marker) must name a promotion that is already
        // terminal -- an open promotion's own deployment is attributed by finalize / reconcile.
        if (ev.matched_promotion_id) {
          const pr = state.promotions.get(promotionKey(ev.matched_promotion_id));
          if (pr?.phase !== "terminal") return bad("late_effect_matched_promotion_not_terminal");
        }
        const current = deploymentOwners.get(ev.deployment_id);
        if (current !== undefined) {
          return bad(`late_effect_deployment_already_recorded: ${ev.deployment_id} for ${current}`);
        }
        for (const le of state.lateEffects.values()) {
          if (!le.resolved && le.detected.deployment_id === ev.deployment_id) {
            return bad(`late_effect_already_pending: ${ev.deployment_id}`);
          }
        }
        deploymentOwners.set(
          ev.deployment_id,
          ev.matched_promotion_id
            ? ownerOf(ev.matched_promotion_id)
            : `${tkey} late:${ev.event_id}`,
        );
        state.lateEffects.set(ev.event_id, { detected: ev, resolved: null });
        return;
      }
      case "late_effect_resolved": {
        const le = state.lateEffects.get(ev.late_effect_event_id);
        if (!le) return bad("late_effect_unknown");
        if (le.resolved) return bad("late_effect_already_resolved");
        if (le.detected.deployment_id !== ev.deployment_id)
          return bad("late_effect_deployment_mismatch");
        if (
          ev.resolution === "attributed_to_promotion" &&
          !same(ev.attributed_promotion_id, le.detected.matched_promotion_id)
        ) {
          return bad("late_effect_attribution_mismatch");
        }
        le.resolved = ev;
        return;
      }
    }
  });

  for (const state of targets.values()) {
    state.lockReasons = lockReasonsOf(state);
    state.locked = state.lockReasons.length > 0;
    state.pendingLateEffects = [...state.lateEffects.entries()]
      .filter(([, le]) => !le.resolved)
      .map(([event_id, le]) => ({
        event_id,
        deployment_id: le.detected.deployment_id,
        matched_promotion_id: le.detected.matched_promotion_id,
      }));
  }
  return { targets, problems, approvalConsumers, deploymentOwners };
}

export function targetStateOf(fold: PromotionFoldResult, target: PromotionTarget): TargetState {
  return fold.targets.get(canonicalTarget(target)) ?? emptyTarget(target);
}
