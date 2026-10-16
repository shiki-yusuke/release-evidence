// TS shapes for release-evidence-promotion/0 (schema/promotion-event.schema.json). Shape only:
// runtime validity is decided by validatePromotionEvent() (fold.ts), which runs the real schema
// plus the calendar check. Treat anything read from the ledger as unvalidated until then.

import { canonicalize, sha256hex } from "#vendor/jcs.mjs";

export const PROMOTION_SCHEMA_VERSION = "release-evidence-promotion/0";
export const PAGES_ENVIRONMENT = "github-pages";

export interface PromotionTarget {
  repository: string;
  environment: "github-pages";
}

export interface PromotionId {
  run_id: string;
  run_attempt: number;
}

export interface SourceArtifact {
  id: string;
  name: string;
  /** Actions API `artifact.digest` of the zip archive (checked against real bytes when given). */
  archive_digest: string;
  /** JCS sha256 of the content manifest recomputed from the extracted site (= the sealed
   * bundle's static_site artifacts[].digest). Not the archive digest -- see the protocol doc. */
  content_manifest_digest: string;
  /** The source run's `release-evidence-out-<run_id>-<run_attempt>` artifact whose zip
   * receipt.json and bundle.json were extracted from. archive_digest = Actions API
   * `artifact.digest`, which the zip bytes matched before extraction. */
  evidence_artifact: { id: string; name: string; archive_digest: string };
}

/** Promotion id synthesized from the evidence artifact name while the receipt carries none. */
export interface DerivedPromotionId {
  run_id: string;
  run_attempt: number;
  derived_from: "artifact_name";
}

export interface ProviderEvidence {
  sha: string;
  environment: string;
  created_at: string;
  observed_state: string;
}

export interface HumanConfirmation {
  confirmed_full_listing: true;
  observed_at: string;
  actor_login: string;
}

export interface ApprovalSubject {
  receipt_digest: string;
  receipt_semantic_digest: string;
  bundle_digest: string;
  selection_manifest_digest: string;
  target: "preview" | "staging" | "production";
}

/** release-approval/v0 event (playbook-owned, carried verbatim). */
export interface ApprovalEvent {
  schema_version: "release-approval/v0";
  event_id: string;
  kind: "approval_granted" | "approval_rejected" | "approval_revoked" | "break_glass_approve";
  subject: ApprovalSubject;
  principal: { principal_id: string; issuer: string; role_snapshot: string };
  occurred_at: string;
  expires_at?: string;
  revoked_approval_event_id?: string;
  bypassed_predicate_ids?: string[];
  incident_ref?: string;
  recorded_after_side_effect?: boolean;
}

interface Base {
  schema_version: typeof PROMOTION_SCHEMA_VERSION;
  event_id: string;
  target: PromotionTarget;
  occurred_at: string;
  actor: "ci";
}

export interface AuthorityIngestedEvent extends Base {
  kind: "authority_ingested";
  authority_event: ApprovalEvent;
  source: { ref: "main"; commit_oid: string; path: string; line: number };
}

export interface ExternalEffect {
  deployment_id: string;
  sha: string;
  environment: "github-pages";
  created_at: string;
  observed_state: string;
}

export interface AuthorizedEvent extends Base {
  kind: "authorized";
  promotion_id: PromotionId;
  approval_event_id: string;
  approval_kind: "approval_granted" | "break_glass_approve";
  recorded_after_side_effect: boolean;
  subject_digest: string;
  subject: ApprovalSubject;
  site_url: string;
  evaluated_at: string;
  time_source: "github_api_date";
  expiry_safety_window_s: number;
  expires_at: string;
  executor: PromotionId;
  resolved: {
    source_run: { run_id: string; run_attempt: number; head_sha: string; conclusion: "success" };
    source_artifact: SourceArtifact;
    bundle_digest: string;
    receipt_digest: string;
    /** The receipt's own promotion_id (null while promotion-receipt/v0 has none). */
    receipt_promotion_id: PromotionId | null;
    /** Set only when receipt_promotion_id is null. Exactly one of the two is non-null. */
    derived_promotion_id: DerivedPromotionId | null;
    resolver_source: { store: "github_actions_artifacts"; namespace: string };
  };
  external_effect: ExternalEffect | null;
}

export interface EffectSendEvent extends Base {
  kind: "effect_send";
  promotion_id: PromotionId;
  bundle_digest: string;
  source_artifact: SourceArtifact;
  /** name = `github-pages-<executor.run_id>-<executor.run_attempt>` (exact, unique in the
   * executor run's artifacts, not expired, workflow_run.id = executor.run_id). */
  pages_artifact: { id: string; name: string; archive_digest: string };
  request_fingerprint: string;
  pages_build_version: string;
  send_at: string;
}

export interface EffectRequestedEvent extends Base {
  kind: "effect_requested";
  promotion_id: PromotionId;
  deployment_id: string | null;
  status_url: string | null;
  response_observed: boolean;
  request_fingerprint: string;
  requested_at: string;
}

export type ProviderTerminalState = "success" | "failure" | "error" | "inactive";

export interface ReconcileRecord {
  human_confirmation: HumanConfirmation;
  listing: {
    pages_fetched: number;
    total: number;
    newest_created_at: string | null;
    oldest_created_at: string | null;
    pages_listing: "checked" | "unsupported";
  } | null;
  criteria: { environment: "github-pages"; sha: string; created_at_not_before: string };
}

export interface TerminalEvent extends Base {
  kind: "terminal";
  promotion_id: PromotionId;
  deployment_id: string | null;
  via: "provider_poll" | "reconcile";
  resolution: "operation_completed" | "abandoned_no_effect";
  operation_completed: {
    state: ProviderTerminalState;
    status_id: string;
    observed_at: string;
  } | null;
  desired_state_observed: {
    live_digest: string;
    expected_digest: string;
    matches: boolean;
    observed_at: string;
  } | null;
  outcome: "completed" | "failed" | "abandoned_no_effect";
  reconcile: ReconcileRecord | null;
}

export interface RevokedAfterConsumeEvent extends Base {
  kind: "revoked_after_consume";
  promotion_id: PromotionId;
  approval_event_id: string;
  revoke_event_id: string;
}

export interface LateEffectDetectedEvent extends Base {
  kind: "late_effect_detected";
  deployment_id: string;
  matched_promotion_id: PromotionId | null;
  provider_evidence: ProviderEvidence;
}

export interface LateEffectResolvedEvent extends Base {
  kind: "late_effect_resolved";
  late_effect_event_id: string;
  deployment_id: string;
  resolution: "attributed_to_promotion" | "external_unattributed";
  attributed_promotion_id: PromotionId | null;
  human_confirmation: HumanConfirmation;
  provider_evidence: ProviderEvidence;
}

export type PromotionEvent =
  | AuthorityIngestedEvent
  | AuthorizedEvent
  | EffectSendEvent
  | EffectRequestedEvent
  | TerminalEvent
  | RevokedAfterConsumeEvent
  | LateEffectDetectedEvent
  | LateEffectResolvedEvent;

export type PromotionEventKind = PromotionEvent["kind"];

/** Distributes Omit over the union so each member keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PromotionEventDraft = DistributiveOmit<
  PromotionEvent,
  "schema_version" | "event_id" | "actor" | "target" | "occurred_at"
>;

/** Provider deployment state -> terminal outcome. States missing here (pending, queued,
 * in_progress, anything unknown) cannot be written as a terminal. Mirrored in the schema. */
export const TERMINAL_OUTCOME: Record<ProviderTerminalState, "completed" | "failed"> = {
  success: "completed",
  failure: "failed",
  error: "failed",
  inactive: "failed",
};

export function isTerminalState(state: string): state is ProviderTerminalState {
  return Object.hasOwn(TERMINAL_OUTCOME, state);
}

export function promotionKey(id: PromotionId): string {
  return `${id.run_id}:${id.run_attempt}`;
}

export function canonicalTarget(target: PromotionTarget): string {
  return `${target.repository}#${target.environment}`;
}

/** Exit codes of `promote <sub>` (docs/promotion-protocol.md). */
export const EXIT = {
  ok: 0,
  ledgerInvalid: 1,
  usage: 2,
  precondition: 3,
  casExhausted: 4,
  readBackMismatch: 5,
  nonTerminal: 6,
} as const;

/** Thrown anywhere in src/promotion/** to abort with a specific exit code. Thrown from inside a
 * CAS `buildEvents` callback, it aborts the attempt before anything is pushed. */
export class PromotionError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PromotionError";
  }
}

export function jcsDigest(value: unknown): string {
  return `sha256:${sha256hex(canonicalize(value))}`;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;

/** UTC `Z` timestamp that names a real calendar instant (Date.UTC round trip: 2026-02-30 is
 * rejected even though it matches the pattern). */
export function isCalendarTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = TIMESTAMP.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === s
  );
}
