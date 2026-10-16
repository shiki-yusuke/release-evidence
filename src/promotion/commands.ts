// `promote <sub>`: the adapter that binds one release-approval/v0 approval to exactly one
// GitHub Pages production send. Every write goes through casCommit (git-cas.ts) and follows the
// same order inside the CAS callback: ingest authority -> late-effect scan -> precondition
// evaluation -> the command's own event(s). Anything evaluated outside the callback (provider
// facts such as run/artifact/deployment state) is re-checked against the fold inside it.
//
// Exit codes: 0 ok / 1 ledger invalid / 2 usage-config / 3 precondition unmet (nothing written)
// / 4 CAS retries exhausted / 5 read-back mismatch (history rewritten) / 6 non-terminal (lock
// stays). Output is one JSON object on stdout.

import { readFileSync } from "node:fs";
import { bundleDigest, validateBundle as coreValidateBundle } from "../core/bundle.js";
import type { Bundle } from "../core/types.js";
import { checkReceiptAgainstVendoredVerifier } from "../shadow-cli/vendor-loader.js";
import {
  readVerifiedArchive,
  sha256File,
  staticSiteArtifact,
  verifyArchive,
  verifySiteContent,
} from "./artifact.js";
import {
  type AuthoritySnapshot,
  PAGES_APPROVAL_TIER,
  authorityPath,
  readAuthority,
} from "./authority.js";
import { type PromotionConfig, loadConfig } from "./config.js";
import {
  type PromotionFoldResult,
  type PromotionState,
  type TargetState,
  buildEvent,
  foldPromotionLedger,
  lockReasonsOf,
  targetStateOf,
} from "./fold.js";
import {
  type CasContext,
  type CasHooks,
  type GitRunner,
  type LedgerRepo,
  casCommit,
  execGit,
  loadLedger,
  verifyRemote,
} from "./git-cas.js";
import {
  type Deployment,
  type FetchFn,
  GitHubProvider,
  type MatchesPromotion,
  type PromotionMatchInput,
  matchesPromotion as defaultMatches,
  resolveRunArtifact,
} from "./provider.js";
import {
  type ApprovalEvent,
  type DerivedPromotionId,
  EXIT,
  type ExternalEffect,
  type HumanConfirmation,
  PAGES_ENVIRONMENT,
  PromotionError,
  type PromotionEvent,
  type PromotionEventDraft,
  type PromotionId,
  type PromotionTarget,
  type ReconcileRecord,
  TERMINAL_OUTCOME,
  type TerminalEvent,
  isCalendarTimestamp,
  isTerminalState,
  jcsDigest,
  promotionKey,
} from "./types.js";
import { ZipError, extractZipEntries } from "./zip.js";

export type Flags = Record<string, string | boolean>;

export interface PromoteDeps {
  fetch: FetchFn;
  git?: GitRunner;
  token?: string | undefined;
  sleep?: (ms: number) => Promise<void>;
  validateBundle?: (bundle: unknown) => string[];
  checkReceipt?: (receipt: unknown) => Promise<string[]>;
  matchesPromotion?: MatchesPromotion;
  hooks?: CasHooks & {
    /** Test seam: after the effect_send CAS landed, before the POST. */
    afterEffectSend?: () => Promise<void>;
    /** Test seam: after the POST returned, before the effect_requested CAS. */
    afterPost?: () => Promise<void>;
  };
}

export interface CommandResult {
  exitCode: number;
  output: Record<string, unknown>;
}

const COMMON = "--config <file> --ledger-repo <dir> --authority-repo <dir> --target <owner/repo>";
export const PROMOTE_USAGE: Record<string, string> = {
  "lock-status": `release-evidence promote lock-status ${COMMON}`,
  ingest: `release-evidence promote ingest ${COMMON} [--github-api <url>]`,
  authorize: `release-evidence promote authorize ${COMMON} --run-id <id> --run-attempt <n> --executor-run-id <id> --executor-run-attempt <n> --approval-event-id <sha256:...> --evidence-archive <release-evidence-out-<run_id>-<run_attempt> zip, as downloaded from archive_download_url> --site-url <https://...> --site-dir <dir> [--archive-path <zip>] [--break-glass [--external-deployment-id <id>]] [--github-api <url>]`,
  send: `release-evidence promote send ${COMMON} --run-id <id> --run-attempt <n> --pages-artifact-id <id> --pages-artifact-archive <zip> --oidc-token-file <file> [--github-api <url>]`,
  finalize: `release-evidence promote finalize ${COMMON} --run-id <id> --run-attempt <n> --page-url <https://...> --expected-digest <sha256:...> [--max-wait-s 600] [--poll-interval-s 10] [--github-api <url>]`,
  reconcile: `release-evidence promote reconcile ${COMMON} --confirmed-full-listing --observed-at <UTC ts> --actor-login <login> (--run-id <id> --run-attempt <n> [--candidate-deployment-id <id>] | --late-effect-event-id <id>) [--github-api <url>]`,
};

const COMMON_FLAGS = ["config", "ledger-repo", "authority-repo", "target", "help", "h"];
export const PROMOTE_ALLOWED_FLAGS: Record<string, string[]> = {
  "lock-status": COMMON_FLAGS,
  ingest: [...COMMON_FLAGS, "github-api"],
  authorize: [
    ...COMMON_FLAGS,
    "run-id",
    "run-attempt",
    "executor-run-id",
    "executor-run-attempt",
    "approval-event-id",
    "evidence-archive",
    "site-url",
    "site-dir",
    "archive-path",
    "break-glass",
    "external-deployment-id",
    "github-api",
  ],
  send: [
    ...COMMON_FLAGS,
    "run-id",
    "run-attempt",
    "pages-artifact-id",
    "pages-artifact-archive",
    "oidc-token-file",
    "github-api",
  ],
  finalize: [
    ...COMMON_FLAGS,
    "run-id",
    "run-attempt",
    "page-url",
    "expected-digest",
    "max-wait-s",
    "poll-interval-s",
    "github-api",
  ],
  reconcile: [
    ...COMMON_FLAGS,
    "run-id",
    "run-attempt",
    "confirmed-full-listing",
    "observed-at",
    "actor-login",
    "candidate-deployment-id",
    "late-effect-event-id",
    "github-api",
  ],
};

// ---------------------------------------------------------------------------------------------
// flag parsing

function usage(msg: string): never {
  throw new PromotionError(EXIT.usage, msg);
}

function req(flags: Flags, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) usage(`missing required flag --${name}`);
  return v;
}

function opt(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  if (v === true) usage(`--${name} needs a value`);
  return typeof v === "string" ? v : undefined;
}

function reqPattern(flags: Flags, name: string, re: RegExp): string {
  const v = req(flags, name);
  if (!re.test(v)) usage(`--${name} "${v}" does not match ${re}`);
  return v;
}

function reqInt(flags: Flags, name: string, min: number): number {
  const v = req(flags, name);
  if (!/^[0-9]{1,10}$/.test(v) || Number(v) < min) usage(`--${name} must be an integer >= ${min}`);
  return Number(v);
}

const RUN_ID = /^[1-9][0-9]{0,19}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TARGET = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

function promotionIdFlags(flags: Flags, prefix = ""): PromotionId {
  return {
    run_id: reqPattern(flags, `${prefix}run-id`, RUN_ID),
    run_attempt: reqInt(flags, `${prefix}run-attempt`, 1),
  };
}

function parseJson(bytes: Buffer, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    usage(`cannot parse ${what} from the evidence archive: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// shared context

interface Ctx {
  deps: PromoteDeps;
  config: PromotionConfig;
  repo: LedgerRepo;
  target: PromotionTarget;
  authorityRepo: string;
  provider: GitHubProvider;
  matches: MatchesPromotion;
}

async function setup(flags: Flags, deps: PromoteDeps): Promise<Ctx> {
  const config = loadConfig(req(flags, "config"));
  const repository = req(flags, "target").toLowerCase();
  if (!TARGET.test(repository)) usage(`--target "${repository}" is not owner/repo`);
  const git = deps.git ?? execGit;
  const repo: LedgerRepo = { git, repoDir: req(flags, "ledger-repo"), config };
  await verifyRemote(repo);
  const apiBase = opt(flags, "github-api") ?? "https://api.github.com";
  if (!/^https?:\/\//.test(apiBase)) usage("--github-api must be an http(s) URL");
  return {
    deps,
    config,
    repo,
    target: { repository, environment: PAGES_ENVIRONMENT },
    authorityRepo: req(flags, "authority-repo"),
    provider: new GitHubProvider({ fetch: deps.fetch, apiBase, repository, token: deps.token }),
    matches: deps.matchesPromotion ?? defaultMatches,
  };
}

function readTargetAuthority(c: Ctx): Promise<AuthoritySnapshot> {
  return readAuthority(
    c.repo.git,
    c.authorityRepo,
    authorityPath(c.config.authority_path_template, c.target.repository),
  );
}

/** authority_ingested for every not-yet-ingested event of this target (grants before revokes so
 * a revoke always follows its target), plus revoked_after_consume for a revoke of an approval
 * that was already consumed. */
function planIngest(
  fold: PromotionFoldResult,
  state: TargetState,
  authority: AuthoritySnapshot,
): PromotionEventDraft[] {
  const ingested = new Set<string>();
  for (const t of fold.targets.values()) for (const id of t.authority.keys()) ingested.add(id);
  const pending = authority.entries.filter((e) => !ingested.has(e.event.event_id));
  const ordered = [
    ...pending.filter((e) => e.event.kind !== "approval_revoked"),
    ...pending.filter((e) => e.event.kind === "approval_revoked"),
  ];
  const drafts: PromotionEventDraft[] = [];
  for (const entry of ordered) {
    drafts.push({
      kind: "authority_ingested",
      authority_event: entry.event,
      source: {
        ref: "main",
        commit_oid: authority.commit_oid,
        path: authority.path,
        line: entry.line,
      },
    });
    const revoked = entry.event.revoked_approval_event_id;
    if (
      entry.event.kind === "approval_revoked" &&
      revoked &&
      state.consumedApprovalIds.has(revoked)
    ) {
      const consumer = [...state.promotions.values()].find(
        (p) => p.authorized.approval_event_id === revoked,
      );
      if (consumer) {
        drafts.push({
          kind: "revoked_after_consume",
          promotion_id: consumer.promotion_id,
          approval_event_id: revoked,
          revoke_event_id: entry.event.event_id,
        });
      }
    }
  }
  return drafts;
}

function matchInput(p: PromotionState): PromotionMatchInput {
  return {
    pages_build_version: p.effectSend?.pages_build_version ?? "",
    head_sha: p.authorized.resolved.source_run.head_sha,
    send_at: p.effectSend?.send_at ?? p.authorized.evaluated_at,
  };
}

async function observedState(c: Ctx, deploymentId: string): Promise<string> {
  const { latest } = await c.provider.listDeploymentStatuses(deploymentId);
  return latest?.state ?? "no_status";
}

/** late_effect_detected for any deployment matching a promotion that was closed as
 * abandoned_no_effect (the "nothing happened" conclusion turned out wrong). */
async function planLateEffects(c: Ctx, state: TargetState): Promise<PromotionEventDraft[]> {
  const known = new Set([...state.lateEffects.values()].map((le) => le.detected.deployment_id));
  const drafts: PromotionEventDraft[] = [];
  for (const p of state.promotions.values()) {
    if (p.terminal?.resolution !== "abandoned_no_effect" || !p.effectSend) continue;
    const input = matchInput(p);
    const since = new Date(Date.parse(input.send_at) - c.config.reconcile_lookback_s * 1000);
    const listing = await c.provider.listDeployments({
      environment: PAGES_ENVIRONMENT,
      since: since.toISOString(),
    });
    if (!listing.complete) {
      throw new PromotionError(EXIT.precondition, `late-effect scan incomplete: ${listing.reason}`);
    }
    for (const d of listing.items) {
      if (known.has(d.id) || !c.matches(d, input, c.config.reconcile_lookback_s)) continue;
      known.add(d.id);
      drafts.push({
        kind: "late_effect_detected",
        deployment_id: d.id,
        matched_promotion_id: p.promotion_id,
        provider_evidence: {
          sha: d.sha,
          environment: d.environment,
          created_at: d.created_at,
          observed_state: await observedState(c, d.id),
        },
      });
    }
  }
  return drafts;
}

interface Prelude {
  now: string;
  drafts: PromotionEventDraft[];
  fold: PromotionFoldResult;
  state: TargetState;
}

/** Common first half of every write: provider time, ingest, (optionally) late-effect scan, and
 * the fold as it will look once those events are appended. */
async function prelude(
  c: Ctx,
  cas: CasContext,
  authority: AuthoritySnapshot,
  opts: { lateEffects: boolean },
): Promise<Prelude> {
  const now = await c.provider.fetchNow();
  const drafts = planIngest(cas.fold, targetStateOf(cas.fold, c.target), authority);
  let fold = foldWith(c, cas, drafts, now);
  if (opts.lateEffects) {
    drafts.push(...(await planLateEffects(c, targetStateOf(fold, c.target))));
    fold = foldWith(c, cas, drafts, now);
  }
  return { now, drafts, fold, state: targetStateOf(fold, c.target) };
}

function foldWith(
  c: Ctx,
  cas: CasContext,
  drafts: PromotionEventDraft[],
  now: string,
): PromotionFoldResult {
  const fold = foldPromotionLedger([...cas.events, ...materialize(c, drafts, now)]);
  if (fold.problems.length > 0) {
    throw new PromotionError(EXIT.precondition, "ingest would make the ledger invalid", {
      problems: fold.problems,
    });
  }
  return fold;
}

function materialize(c: Ctx, drafts: PromotionEventDraft[], now: string): PromotionEvent[] {
  return drafts.map((d) => buildEvent(d, c.target, now));
}

/** casCommit with the common prelude (ingest + late-effect scan). `specific` returns the
 * command's own drafts or throws. A precondition failure normally writes nothing -- except when
 * this attempt detected a late effect: the detection (with the ingest before it) is committed
 * anyway, so the lock it causes is durable, and the refusal is re-thrown afterwards. */
async function casWithPrelude(
  c: Ctx,
  authority: AuthoritySnapshot,
  specific: (pre: Prelude) => Promise<PromotionEventDraft[]>,
) {
  let deferred: PromotionError | undefined;
  const result = await casCommit(
    c.repo,
    async (cas) => {
      deferred = undefined;
      const pre = await prelude(c, cas, authority, { lateEffects: true });
      try {
        return materialize(c, [...pre.drafts, ...(await specific(pre))], pre.now);
      } catch (err) {
        const detected = pre.drafts.some((d) => d.kind === "late_effect_detected");
        if (!(err instanceof PromotionError && err.exitCode === EXIT.precondition && detected)) {
          throw err;
        }
        deferred = err;
        return materialize(c, pre.drafts, pre.now);
      }
    },
    c.deps.hooks,
  );
  if (deferred) {
    throw new PromotionError(deferred.exitCode, deferred.message, {
      ...deferred.details,
      late_effects_recorded: summarize(result),
    });
  }
  return result;
}

function unmet(msg: string, details: Record<string, unknown> = {}): never {
  throw new PromotionError(EXIT.precondition, msg, details);
}

function requirePromotion(state: TargetState, id: PromotionId): PromotionState {
  const p = state.promotions.get(promotionKey(id));
  if (!p) unmet(`no authorized promotion ${promotionKey(id)} for this target`);
  return p;
}

function summarize(committed: {
  committed: boolean;
  commit: string | null;
  events: PromotionEvent[];
  attempts: number;
}) {
  return {
    attempts: committed.attempts,
    committed: committed.committed,
    commit: committed.commit,
    events: committed.events.map((e) => ({ kind: e.kind, event_id: e.event_id })),
  };
}

// ---------------------------------------------------------------------------------------------
// lock-status / ingest

async function cmdLockStatus(c: Ctx): Promise<CommandResult> {
  let fold: PromotionFoldResult;
  try {
    ({ fold } = await loadLedger(c.repo));
  } catch (err) {
    if (err instanceof PromotionError && err.exitCode === EXIT.ledgerInvalid) {
      return {
        exitCode: EXIT.ok,
        output: { locked: true, reasons: ["ledger_invalid"], problems: err.details.problems ?? [] },
      };
    }
    throw err;
  }
  const state = targetStateOf(fold, c.target);
  return {
    exitCode: EXIT.ok,
    output: {
      target: c.target,
      locked: state.locked,
      reasons: state.lockReasons,
      open_promotions: [...state.promotions.values()]
        .filter((p) => p.phase !== "terminal")
        .map((p) => ({
          promotion_id: p.promotion_id,
          phase: p.phase,
          approval_event_id: p.authorized.approval_event_id,
        })),
      pending_late_effects: state.pendingLateEffects,
    },
  };
}

async function cmdIngest(c: Ctx): Promise<CommandResult> {
  const authority = await readTargetAuthority(c);
  const result = await casCommit(
    c.repo,
    async (cas) => {
      const drafts = planIngest(cas.fold, targetStateOf(cas.fold, c.target), authority);
      if (drafts.length === 0) return [];
      const now = await c.provider.fetchNow();
      foldWith(c, cas, drafts, now);
      return materialize(c, drafts, now);
    },
    c.deps.hooks,
  );
  return { exitCode: EXIT.ok, output: summarize(result) };
}

// ---------------------------------------------------------------------------------------------
// authorize

interface AuthorizeInputs {
  promotionId: PromotionId;
  executor: PromotionId;
  approvalEventId: string;
  breakGlass: boolean;
  externalDeploymentId: string | undefined;
  bundleDigest: string;
  receiptDigest: string;
}

/** Consume preconditions that depend only on the (post-ingest) fold. */
function evaluateConsume(
  state: TargetState,
  fold: PromotionFoldResult,
  inp: AuthorizeInputs,
): ApprovalEvent {
  const locks = lockReasonsOf(state);
  if (locks.length > 0) unmet("target is locked", { reasons: locks });
  if (state.promotions.has(promotionKey(inp.promotionId))) {
    unmet(`promotion ${promotionKey(inp.promotionId)} was already authorized`);
  }
  const consumer = fold.approvalConsumers.get(inp.approvalEventId);
  if (consumer) unmet(`approval ${inp.approvalEventId} was already consumed (${consumer})`);
  const ingested = state.authority.get(inp.approvalEventId);
  if (!ingested) unmet(`approval ${inp.approvalEventId} is not in this target's authority`);
  const approval = ingested.event;
  const wantKind = inp.breakGlass ? "break_glass_approve" : "approval_granted";
  if (approval.kind !== wantKind) unmet(`approval kind is ${approval.kind}, expected ${wantKind}`);
  if (state.revokes.has(approval.event_id)) unmet(`approval ${approval.event_id} was revoked`);
  if (approval.subject.target !== PAGES_APPROVAL_TIER)
    unmet("approval subject.target is not production");
  if (approval.subject.bundle_digest !== inp.bundleDigest) {
    unmet(
      `approval bundle_digest ${approval.subject.bundle_digest} != sealed bundle ${inp.bundleDigest}`,
    );
  }
  if (approval.subject.receipt_digest !== inp.receiptDigest) {
    unmet(
      `approval receipt_digest ${approval.subject.receipt_digest} != receipt ${inp.receiptDigest}`,
    );
  }
  const afterEffect = approval.recorded_after_side_effect === true;
  if (afterEffect && !inp.externalDeploymentId) {
    usage("break_glass approval recorded_after_side_effect requires --external-deployment-id");
  }
  if (!afterEffect && inp.externalDeploymentId) {
    unmet(
      "--external-deployment-id is only valid for a recorded_after_side_effect break_glass approval",
    );
  }
  return approval;
}

function checkExpiry(approval: ApprovalEvent, now: string, windowS: number, when: string): void {
  const margin = (Date.parse(approval.expires_at ?? "") - Date.parse(now)) / 1000;
  if (!(margin > windowS)) {
    unmet(`approval expires too soon (${when}): ${margin}s left, safety window ${windowS}s`, {
      expires_at: approval.expires_at,
      now,
    });
  }
}

async function cmdAuthorize(c: Ctx, flags: Flags): Promise<CommandResult> {
  const breakGlass = flags["break-glass"] === true;
  if (flags["break-glass"] !== undefined && !breakGlass) usage("--break-glass takes no value");
  const externalDeploymentId = opt(flags, "external-deployment-id");
  if (externalDeploymentId !== undefined && !breakGlass) {
    usage("--external-deployment-id requires --break-glass");
  }
  const promotionId = promotionIdFlags(flags);
  const executor = promotionIdFlags(flags, "executor-");
  const approvalEventId = reqPattern(flags, "approval-event-id", DIGEST);
  const siteUrl = reqPattern(flags, "site-url", /^https:\/\/\S+$/);
  const siteDir = req(flags, "site-dir");
  const archivePath = opt(flags, "archive-path");

  // Receipt and bundle come from the evidence artifact of THIS source run attempt, resolved by
  // its exact name in the Actions API listing: the zip bytes given on the command line must hash
  // to that artifact's digest, and receipt.json / bundle.json are extracted from those same bytes
  // (never from an extracted directory on disk). This listing is the one provider call made
  // before the early ledger refusal, because the refusal needs the receipt/bundle digests.
  const suffix = `${promotionId.run_id}-${promotionId.run_attempt}`;
  const evidenceName = `release-evidence-out-${suffix}`;
  const evidenceArchive = req(flags, "evidence-archive");
  const listing = await c.provider.listRunArtifacts(promotionId.run_id);
  const outArtifact = resolveRunArtifact(listing, evidenceName);
  const evidence = readVerifiedArchive(evidenceArchive, outArtifact.digest as string);
  let files: Map<string, Buffer>;
  try {
    files = extractZipEntries(evidence.bytes, ["bundle.json", "receipt.json"]);
  } catch (err) {
    if (err instanceof ZipError) unmet(`evidence archive ${evidenceName}: ${err.message}`);
    throw err;
  }
  const bundle = parseJson(files.get("bundle.json") as Buffer, "bundle.json") as Bundle;
  const bundleProblems = (c.deps.validateBundle ?? coreValidateBundle)(bundle);
  if (bundleProblems.length > 0) usage(`sealed bundle is invalid: ${bundleProblems.join("; ")}`);
  const receipt = parseJson(files.get("receipt.json") as Buffer, "receipt.json") as {
    subject?: { bundle_digest?: string; target?: string };
    promotion_id?: unknown;
  };
  const receiptProblems = await (c.deps.checkReceipt ?? checkReceiptAgainstVendoredVerifier)(
    receipt,
  );
  if (receiptProblems.length > 0) usage(`receipt is invalid: ${receiptProblems.join("; ")}`);
  // receipt_promotion_id = the receipt's own promotion_id (must equal the promotion exactly);
  // until the receipt carries one, it is null and derived_promotion_id records the id taken from
  // the artifact name instead. Exactly one of the two is non-null.
  let receiptPromotionId: PromotionId | null = null;
  let derivedPromotionId: DerivedPromotionId | null = null;
  if (Object.hasOwn(receipt, "promotion_id")) {
    const rid = receipt.promotion_id as Partial<PromotionId> | null;
    const keys = rid !== null && typeof rid === "object" ? Object.keys(rid).sort() : [];
    if (
      keys.join(",") !== "run_attempt,run_id" ||
      rid?.run_id !== promotionId.run_id ||
      rid?.run_attempt !== promotionId.run_attempt
    ) {
      unmet(
        `receipt promotion_id ${JSON.stringify(receipt.promotion_id)} != ${promotionKey(promotionId)}`,
      );
    }
    receiptPromotionId = { run_id: promotionId.run_id, run_attempt: promotionId.run_attempt };
  } else {
    derivedPromotionId = {
      run_id: promotionId.run_id,
      run_attempt: promotionId.run_attempt,
      derived_from: "artifact_name",
    };
  }
  const inputs: AuthorizeInputs = {
    promotionId,
    executor,
    approvalEventId,
    breakGlass,
    externalDeploymentId,
    bundleDigest: bundleDigest(bundle),
    receiptDigest: jcsDigest(receipt),
  };
  if (receipt.subject?.bundle_digest !== inputs.bundleDigest) {
    unmet("receipt subject.bundle_digest does not match bundle.json");
  }
  if (receipt.subject?.target !== PAGES_APPROVAL_TIER)
    unmet("receipt subject.target is not production");

  // Early refusal from the ledger alone (no provider calls when the answer is already "no").
  const authority = await readTargetAuthority(c);
  {
    const { snapshot, fold } = await loadLedger(c.repo);
    const drafts = planIngest(fold, targetStateOf(fold, c.target), authority);
    const pre = foldPromotionLedger([
      ...snapshot.events,
      ...materialize(c, drafts, "1970-01-01T00:00:00Z"),
    ]);
    evaluateConsume(targetStateOf(pre, c.target), pre, inputs);
  }

  // Provider facts: source run, its artifacts, and the extracted site.
  const run = await c.provider.getRunAttempt(promotionId.run_id, promotionId.run_attempt);
  if (run.status !== "completed" || run.conclusion !== "success") {
    unmet(`source run ${promotionKey(promotionId)} is ${run.status}/${run.conclusion}`);
  }
  if (run.head_sha !== bundle.source.commit_sha) {
    unmet(
      `source run head_sha ${run.head_sha} != bundle source.commit_sha ${bundle.source.commit_sha}`,
    );
  }
  const siteArtifact = resolveRunArtifact(listing, `site-dist-${suffix}`);
  if (archivePath !== undefined) verifyArchive(archivePath, siteArtifact.digest as string);
  const contentDigest = verifySiteContent(siteDir, staticSiteArtifact(bundle));

  let externalEffect: ExternalEffect | null = null;
  if (externalDeploymentId !== undefined) {
    const d = await c.provider.getDeployment(externalDeploymentId);
    if (!d) unmet(`external deployment ${externalDeploymentId} not found`);
    if (d.environment !== PAGES_ENVIRONMENT)
      unmet(`external deployment environment is ${d.environment}`);
    if (d.sha !== run.head_sha)
      unmet(`external deployment sha ${d.sha} != source head_sha ${run.head_sha}`);
    externalEffect = {
      deployment_id: d.id,
      sha: d.sha,
      environment: PAGES_ENVIRONMENT,
      created_at: d.created_at,
      observed_state: await observedState(c, d.id),
    };
  }

  const result = await casWithPrelude(c, authority, async (pre) => {
    const approval = evaluateConsume(pre.state, pre.fold, inputs);
    checkExpiry(approval, pre.now, c.config.expiry_safety_window_s, "evaluation");
    const authorized: PromotionEventDraft = {
      kind: "authorized",
      promotion_id: promotionId,
      approval_event_id: approval.event_id,
      approval_kind: approval.kind as "approval_granted" | "break_glass_approve",
      recorded_after_side_effect: approval.recorded_after_side_effect === true,
      subject_digest: jcsDigest(approval.subject),
      subject: approval.subject,
      site_url: siteUrl,
      evaluated_at: pre.now,
      time_source: "github_api_date",
      expiry_safety_window_s: c.config.expiry_safety_window_s,
      expires_at: approval.expires_at as string,
      executor,
      resolved: {
        source_run: {
          run_id: promotionId.run_id,
          run_attempt: promotionId.run_attempt,
          head_sha: run.head_sha,
          conclusion: "success",
        },
        source_artifact: {
          id: siteArtifact.id,
          name: siteArtifact.name,
          archive_digest: siteArtifact.digest as string,
          content_manifest_digest: contentDigest,
          evidence_artifact: {
            id: outArtifact.id,
            name: outArtifact.name,
            archive_digest: evidence.digest,
          },
        },
        bundle_digest: inputs.bundleDigest,
        receipt_digest: inputs.receiptDigest,
        receipt_promotion_id: receiptPromotionId,
        derived_promotion_id: derivedPromotionId,
        resolver_source: {
          store: "github_actions_artifacts",
          namespace: `${c.target.repository}/actions/runs/${promotionId.run_id}/attempts/${promotionId.run_attempt}/${outArtifact.name}`,
        },
      },
      external_effect: externalEffect,
    };
    // Last thing before the push: provider time again (expiry is not atomic with the push).
    checkExpiry(approval, await c.provider.fetchNow(), c.config.expiry_safety_window_s, "pre-push");
    return [authorized];
  });
  return { exitCode: EXIT.ok, output: summarize(result) };
}

// ---------------------------------------------------------------------------------------------
// send

async function cmdSend(c: Ctx, flags: Flags): Promise<CommandResult> {
  const promotionId = promotionIdFlags(flags);
  const pagesArtifactId = reqPattern(flags, "pages-artifact-id", RUN_ID);
  const pagesArchiveDigest = sha256File(req(flags, "pages-artifact-archive"));
  const tokenPath = req(flags, "oidc-token-file");
  let oidcToken: string;
  try {
    oidcToken = readFileSync(tokenPath, "utf-8").trim();
  } catch {
    usage("cannot read --oidc-token-file");
  }
  if (oidcToken.length === 0) usage("--oidc-token-file is empty");
  const authority = await readTargetAuthority(c);
  const key = promotionKey(promotionId);

  // Early refusal: the send right is consumed by effect_send, once.
  {
    const { fold } = await loadLedger(c.repo);
    const p = requirePromotion(targetStateOf(fold, c.target), promotionId);
    if (p.phase !== "authorized")
      unmet(`promotion ${key} is ${p.phase}; the send right is already used`);
  }

  let fingerprint = "";
  let pagesBuildVersion = "";
  // Provider facts (source run, both artifacts) are re-read inside the callback, i.e. on every
  // CAS attempt: a retry after a lost lease never reuses what an earlier attempt saw.
  const sendResult = await casWithPrelude(c, authority, async (pre) => {
    const p = requirePromotion(pre.state, promotionId);
    if (p.phase !== "authorized")
      unmet(`promotion ${key} is ${p.phase}; the send right is already used`);
    const auth = p.authorized;
    if (auth.external_effect) unmet("break_glass promotion with an external effect cannot send");
    const locks = lockReasonsOf(pre.state, key);
    if (locks.length > 0) unmet("target is locked", { reasons: locks });

    const run = await c.provider.getRunAttempt(promotionId.run_id, promotionId.run_attempt);
    if (run.status !== "completed" || run.conclusion !== "success")
      unmet("source run no longer success");
    if (run.head_sha !== auth.resolved.source_run.head_sha) unmet("source run head_sha changed");
    const listing = await c.provider.listRunArtifacts(promotionId.run_id);
    const site = resolveRunArtifact(listing, auth.resolved.source_artifact.name);
    if (
      site.id !== auth.resolved.source_artifact.id ||
      site.digest !== auth.resolved.source_artifact.archive_digest
    ) {
      unmet("source artifact changed since authorization");
    }
    // The executor attempt's own Pages artifact, by exact name (upload-pages-artifact `name`).
    const pagesName = `github-pages-${auth.executor.run_id}-${auth.executor.run_attempt}`;
    const pages = resolveRunArtifact(
      await c.provider.listRunArtifacts(auth.executor.run_id),
      pagesName,
    );
    if (pages.workflow_run_id !== auth.executor.run_id) {
      unmet(`pages artifact ${pagesName} was not uploaded by executor run ${auth.executor.run_id}`);
    }
    if (pages.id !== pagesArtifactId) {
      unmet(`--pages-artifact-id ${pagesArtifactId} is not ${pagesName} (id ${pages.id})`);
    }
    if (pages.digest !== pagesArchiveDigest) {
      unmet(`pages artifact digest ${pages.digest} != archive bytes ${pagesArchiveDigest}`);
    }
    pagesBuildVersion = `${auth.resolved.source_run.head_sha}:${promotionId.run_id}:${promotionId.run_attempt}`;
    fingerprint = jcsDigest({
      artifact_id: pagesArtifactId,
      pages_build_version: pagesBuildVersion,
    });
    const draft: PromotionEventDraft = {
      kind: "effect_send",
      promotion_id: promotionId,
      bundle_digest: auth.resolved.bundle_digest,
      source_artifact: auth.resolved.source_artifact,
      pages_artifact: { id: pagesArtifactId, name: pagesName, archive_digest: pagesArchiveDigest },
      request_fingerprint: fingerprint,
      pages_build_version: pagesBuildVersion,
      send_at: pre.now,
    };
    return [draft];
  });

  // From here on the send right is consumed: whatever fails, there is no second POST.
  await c.deps.hooks?.afterEffectSend?.();
  const post = await c.provider.createPagesDeployment({
    artifact_id: pagesArtifactId,
    oidc_token: oidcToken,
    pages_build_version: pagesBuildVersion,
  });
  await c.deps.hooks?.afterPost?.();
  const deploymentId = post.kind === "created" ? post.id : null;
  const base = {
    effect_send: summarize(sendResult),
    post: post.kind === "created" ? { kind: post.kind, deployment_id: post.id } : post,
  };

  try {
    const requested = await casCommit(
      c.repo,
      async (cas) => {
        const pre = await prelude(c, cas, authority, { lateEffects: false });
        const p = requirePromotion(pre.state, promotionId);
        if (p.phase !== "sent" || p.effectSend?.request_fingerprint !== fingerprint) {
          unmet(`promotion ${key} is ${p.phase}; effect_requested cannot be recorded`);
        }
        const draft: PromotionEventDraft = {
          kind: "effect_requested",
          promotion_id: promotionId,
          deployment_id: deploymentId,
          status_url: post.kind === "created" ? post.status_url : null,
          response_observed: post.kind !== "unknown",
          request_fingerprint: fingerprint,
          requested_at: pre.now,
        };
        return materialize(c, [...pre.drafts, draft], pre.now);
      },
      c.deps.hooks,
    );
    return {
      exitCode: deploymentId === null ? EXIT.nonTerminal : EXIT.ok,
      output: {
        ...base,
        effect_requested: summarize(requested),
        ...(deploymentId === null ? { next: "reconcile" } : { next: "finalize" }),
      },
    };
  } catch (err) {
    const e =
      err instanceof PromotionError ? err : new PromotionError(EXIT.usage, (err as Error).message);
    throw new PromotionError(
      e.exitCode,
      `POST done but effect_requested not recorded: ${e.message}`,
      {
        ...base,
        ...e.details,
        next: "reconcile",
      },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// finalize

function knownDeploymentId(p: PromotionState): string | null {
  if (p.phase === "authorized" && p.authorized.external_effect) {
    return p.authorized.external_effect.deployment_id;
  }
  if (p.phase === "requested") return p.effectRequested?.deployment_id ?? null;
  return null;
}

async function readLiveManifestDigest(c: Ctx, pageUrl: string): Promise<string | null> {
  try {
    const res = await c.deps.fetch(`${pageUrl.replace(/\/+$/, "")}/release-manifest.json`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200) return null;
    const wrapper = JSON.parse(await res.text()) as { schema_version?: unknown; content?: unknown };
    if (
      wrapper.schema_version !== "release-evidence/v0" ||
      wrapper.content === null ||
      typeof wrapper.content !== "object" ||
      Array.isArray(wrapper.content)
    ) {
      return null;
    }
    return jcsDigest(wrapper.content);
  } catch {
    return null;
  }
}

async function cmdFinalize(c: Ctx, flags: Flags): Promise<CommandResult> {
  const promotionId = promotionIdFlags(flags);
  const pageUrl = reqPattern(flags, "page-url", /^https?:\/\/\S+$/);
  const expectedDigest = reqPattern(flags, "expected-digest", DIGEST);
  const maxWaitS = flags["max-wait-s"] === undefined ? 600 : reqInt(flags, "max-wait-s", 0);
  const intervalS =
    flags["poll-interval-s"] === undefined ? 10 : reqInt(flags, "poll-interval-s", 1);
  const sleep = c.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const authority = await readTargetAuthority(c);
  const key = promotionKey(promotionId);

  const { fold } = await loadLedger(c.repo);
  const p0 = requirePromotion(targetStateOf(fold, c.target), promotionId);
  if (p0.phase === "terminal") unmet(`promotion ${key} is already terminal`);
  const deploymentId = knownDeploymentId(p0);
  if (deploymentId === null) {
    return {
      exitCode: EXIT.nonTerminal,
      output: { status: "deployment_unknown", phase: p0.phase, next: "reconcile" },
    };
  }
  if (expectedDigest !== p0.authorized.resolved.source_artifact.content_manifest_digest) {
    unmet("--expected-digest is not the authorized content manifest digest");
  }

  // The poll only waits for the provider to report a terminal state; the event is built from
  // statuses and the live read-back fetched again inside the CAS callback (every attempt).
  let waited = 0;
  let polled = await c.provider.listDeploymentStatuses(deploymentId);
  while (!(polled.latest && isTerminalState(polled.latest.state))) {
    if (waited >= maxWaitS) {
      return {
        exitCode: EXIT.nonTerminal,
        output: {
          status: "non_terminal",
          deployment_id: deploymentId,
          state: polled.latest?.state ?? null,
          ...(polled.problems.length > 0 ? { problems: polled.problems } : {}),
        },
      };
    }
    await sleep(intervalS * 1000);
    waited += intervalS;
    polled = await c.provider.listDeploymentStatuses(deploymentId);
  }

  const seen = { outcome: "failed" as TerminalEvent["outcome"], liveDigest: null as string | null };
  const result = await casWithPrelude(c, authority, async (pre) => {
    const p = requirePromotion(pre.state, promotionId);
    if (p.phase !== p0.phase || knownDeploymentId(p) !== deploymentId) {
      unmet(`promotion ${key} changed to ${p.phase} while finalizing`);
    }
    const { latest, problems } = await c.provider.listDeploymentStatuses(deploymentId);
    if (!latest || !isTerminalState(latest.state)) {
      throw new PromotionError(EXIT.nonTerminal, "deployment is no longer terminal", {
        status: "non_terminal",
        deployment_id: deploymentId,
        state: latest?.state ?? null,
        ...(problems.length > 0 ? { problems } : {}),
      });
    }
    const state = latest.state;
    const liveDigest = await readLiveManifestDigest(c, pageUrl);
    const outcome = TERMINAL_OUTCOME[state];
    seen.liveDigest = liveDigest;
    seen.outcome = outcome;
    const draft: PromotionEventDraft = {
      kind: "terminal",
      promotion_id: promotionId,
      deployment_id: deploymentId,
      via: "provider_poll",
      resolution: "operation_completed",
      operation_completed: { state, status_id: latest.id, observed_at: pre.now },
      desired_state_observed:
        liveDigest === null
          ? null
          : {
              live_digest: liveDigest,
              expected_digest: expectedDigest,
              matches: liveDigest === expectedDigest,
              observed_at: pre.now,
            },
      outcome,
      reconcile: null,
    };
    return [draft];
  });
  return {
    exitCode: EXIT.ok,
    output: {
      ...summarize(result),
      outcome: seen.outcome,
      desired_state_matches: seen.liveDigest === null ? null : seen.liveDigest === expectedDigest,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// reconcile

function humanConfirmation(flags: Flags): HumanConfirmation {
  if (flags["confirmed-full-listing"] !== true) {
    usage("--confirmed-full-listing (no value) is required: a human checked the full listing");
  }
  const observedAt = req(flags, "observed-at");
  if (!isCalendarTimestamp(observedAt)) usage("--observed-at must be a real UTC ...Z timestamp");
  const login = reqPattern(flags, "actor-login", /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
  return { confirmed_full_listing: true, observed_at: observedAt, actor_login: login };
}

async function cmdReconcileLateEffect(c: Ctx, flags: Flags, human: HumanConfirmation) {
  const lateId = reqPattern(flags, "late-effect-event-id", /^[a-z0-9-]{8,64}$/);
  const authority = await readTargetAuthority(c);
  const { fold } = await loadLedger(c.repo);
  const le = targetStateOf(fold, c.target).lateEffects.get(lateId);
  if (!le || le.resolved) unmet(`late effect ${lateId} is not pending for this target`);
  const result = await casCommit(
    c.repo,
    async (cas) => {
      const pre = await prelude(c, cas, authority, { lateEffects: false });
      const current = pre.state.lateEffects.get(lateId);
      if (!current || current.resolved) unmet(`late effect ${lateId} is no longer pending`);
      // Provider facts per CAS attempt (same rule as promotion-mode reconcile).
      const d = await c.provider.getDeployment(current.detected.deployment_id);
      if (!d) unmet(`deployment ${current.detected.deployment_id} not found`);
      const { latest, problems } = await c.provider.listDeploymentStatuses(d.id);
      if (!latest || !isTerminalState(latest.state)) {
        nonTerminal("non_terminal", {
          deployment_id: d.id,
          state: latest?.state ?? null,
          ...(problems.length > 0 ? { problems } : {}),
        });
      }
      const matchedId = current.detected.matched_promotion_id;
      const matched = matchedId ? pre.state.promotions.get(promotionKey(matchedId)) : undefined;
      const attributed =
        matched !== undefined && c.matches(d, matchInput(matched), c.config.reconcile_lookback_s);
      const draft: PromotionEventDraft = {
        kind: "late_effect_resolved",
        late_effect_event_id: lateId,
        deployment_id: d.id,
        resolution: attributed ? "attributed_to_promotion" : "external_unattributed",
        attributed_promotion_id: attributed ? matchedId : null,
        human_confirmation: human,
        provider_evidence: {
          sha: d.sha,
          environment: d.environment,
          created_at: d.created_at,
          observed_state: latest.state,
        },
      };
      return materialize(c, [...pre.drafts, draft], pre.now);
    },
    c.deps.hooks,
  );
  return { exitCode: EXIT.ok, output: summarize(result) };
}

async function cmdReconcile(c: Ctx, flags: Flags): Promise<CommandResult> {
  const human = humanConfirmation(flags);
  if (flags["late-effect-event-id"] !== undefined) {
    if (flags["run-id"] !== undefined || flags["candidate-deployment-id"] !== undefined) {
      usage("--late-effect-event-id cannot be combined with --run-id/--candidate-deployment-id");
    }
    return cmdReconcileLateEffect(c, flags, human);
  }
  const promotionId = promotionIdFlags(flags);
  const candidateFlag = opt(flags, "candidate-deployment-id");
  const authority = await readTargetAuthority(c);
  const key = promotionKey(promotionId);

  const { fold } = await loadLedger(c.repo);
  const p0 = requirePromotion(targetStateOf(fold, c.target), promotionId);
  if (p0.phase !== "sent" && p0.phase !== "requested") {
    unmet(`promotion ${key} is ${p0.phase}; reconcile applies only after effect_send`);
  }
  const knownId = knownDeploymentId(p0);
  if (knownId !== null && candidateFlag !== undefined && candidateFlag !== knownId) {
    unmet(`candidate ${candidateFlag} != requested deployment ${knownId}`);
  }
  const candidate = candidateFlag ?? knownId ?? undefined;
  const input = matchInput(p0);
  const criteria = {
    environment: PAGES_ENVIRONMENT,
    sha: input.head_sha,
    created_at_not_before: new Date(
      Date.parse(input.send_at) - c.config.reconcile_lookback_s * 1000,
    )
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  } as const;

  // Every provider fact the event depends on (candidate + statuses, the full deployment listing,
  // the Pages listing, provider time) is fetched inside the CAS callback, so a retry after a lost
  // lease re-observes: a deployment that appeared meanwhile turns "absence" into exit 6.
  const result = await casWithPrelude(c, authority, async (pre) => {
    const p = requirePromotion(pre.state, promotionId);
    if (p.phase !== p0.phase) unmet(`promotion ${key} changed to ${p.phase} while reconciling`);
    const draft =
      candidate !== undefined
        ? await candidateTerminal(c, candidate, input, promotionId, key, human, criteria, pre.now)
        : await confirmedAbsence(c, input, promotionId, human, criteria, pre.now);
    return [draft];
  });
  return { exitCode: EXIT.ok, output: summarize(result) };
}

/** exit 6 without writing: the promotion stays open (locked). */
function nonTerminal(status: string, details: Record<string, unknown>): never {
  throw new PromotionError(EXIT.nonTerminal, `reconcile: ${status}`, { status, ...details });
}

type Criteria = ReconcileRecord["criteria"];

async function candidateTerminal(
  c: Ctx,
  candidate: string,
  input: PromotionMatchInput,
  promotionId: PromotionId,
  key: string,
  human: HumanConfirmation,
  criteria: Criteria,
  now: string,
): Promise<PromotionEventDraft> {
  const d = await c.provider.getDeployment(candidate);
  if (!d) nonTerminal("candidate_not_found", { candidate });
  if (!c.matches(d, input, c.config.reconcile_lookback_s)) {
    unmet(`deployment ${candidate} does not match promotion ${key}`);
  }
  const { latest, problems } = await c.provider.listDeploymentStatuses(d.id);
  if (!latest || !isTerminalState(latest.state)) {
    nonTerminal("non_terminal", {
      deployment_id: d.id,
      state: latest?.state ?? null,
      ...(problems.length > 0 ? { problems } : {}),
    });
  }
  const state = latest.state;
  return {
    kind: "terminal",
    promotion_id: promotionId,
    deployment_id: d.id,
    via: "reconcile",
    resolution: "operation_completed",
    operation_completed: { state, status_id: latest.id, observed_at: now },
    desired_state_observed: null,
    outcome: TERMINAL_OUTCOME[state],
    reconcile: { human_confirmation: human, listing: null, criteria },
  };
}

async function confirmedAbsence(
  c: Ctx,
  input: PromotionMatchInput,
  promotionId: PromotionId,
  human: HumanConfirmation,
  criteria: Criteria,
  now: string,
): Promise<PromotionEventDraft> {
  const listing = await c.provider.listDeployments({
    environment: PAGES_ENVIRONMENT,
    since: criteria.created_at_not_before,
  });
  const pages = await c.provider.listPagesDeployments();
  const seen = new Map<string, Deployment>();
  for (const d of [...listing.items, ...pages.items]) {
    if (c.matches(d, input, c.config.reconcile_lookback_s)) seen.set(d.id, d);
  }
  const candidates = [...seen.keys()];
  if (!listing.complete || pages.status === "incomplete") {
    nonTerminal("listing_incomplete", { reason: listing.reason ?? "pages listing incomplete" });
  }
  if (candidates.length > 0) {
    nonTerminal("candidates_found", { candidates, next: "--candidate-deployment-id" });
  }
  const elapsed = (Date.parse(now) - Date.parse(input.send_at)) / 1000;
  if (elapsed < c.config.settle_window_s) {
    nonTerminal("settle_window_open", {
      elapsed_s: elapsed,
      settle_window_s: c.config.settle_window_s,
    });
  }
  const all = [...listing.items, ...pages.items].map((d) => d.created_at).sort();
  return {
    kind: "terminal",
    promotion_id: promotionId,
    deployment_id: null,
    via: "reconcile",
    resolution: "abandoned_no_effect",
    operation_completed: null,
    desired_state_observed: null,
    outcome: "abandoned_no_effect",
    reconcile: {
      human_confirmation: human,
      listing: {
        pages_fetched: listing.pages_fetched,
        total: listing.items.length + pages.items.length,
        newest_created_at: all.at(-1) ?? null,
        oldest_created_at: all[0] ?? null,
        pages_listing: pages.status === "checked" ? "checked" : "unsupported",
      },
      criteria,
    },
  };
}

// ---------------------------------------------------------------------------------------------

export async function runPromote(
  sub: string,
  flags: Flags,
  deps: PromoteDeps,
): Promise<CommandResult> {
  try {
    const c = await setup(flags, deps);
    switch (sub) {
      case "lock-status":
        return await cmdLockStatus(c);
      case "ingest":
        return await cmdIngest(c);
      case "authorize":
        return await cmdAuthorize(c, flags);
      case "send":
        return await cmdSend(c, flags);
      case "finalize":
        return await cmdFinalize(c, flags);
      case "reconcile":
        return await cmdReconcile(c, flags);
      default:
        usage(`unknown promote subcommand "${sub}"`);
    }
  } catch (err) {
    if (err instanceof PromotionError) {
      return { exitCode: err.exitCode, output: { error: err.message, ...err.details } };
    }
    return { exitCode: EXIT.usage, output: { error: (err as Error).message } };
  }
}
