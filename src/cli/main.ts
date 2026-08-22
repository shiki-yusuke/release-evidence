#!/usr/bin/env node
// release-evidence CLI: prepare (seal a bundle + record `prepared`), record <kind> (append one
// ledger transition, refusing anything the fold/gates find illegal), status (fold and print),
// audit (full release-collection check against a ledger + a directory of bundle files), and
// manifest (compute a static_site content manifest and its digest). No subcommand writes
// anything to the ledger without first checking legality -- an illegal transition exits 3 and
// leaves the ledger untouched (ledger.ts's own schema check would refuse it anyway, but the
// fold/gate check runs first so the failure reason is the actual state-machine violation, not
// a generic schema error).
//
// Exit codes: 0 = success (or a clean audit/status). 2 = usage/input error (bad flags, unreadable
// file, schema-invalid record, a --bundle that doesn't match --bundle-digest/--release-id).
// 3 = the fold or a production gate rejected the transition -- the ledger is untouched. 1 =
// `status`/`audit` ran successfully but found the ledger/collection itself unhealthy.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sha256hex } from "#vendor/jcs.mjs";
import { bundleDigest as computeBundleDigest, validateBundle } from "../core/bundle.js";
import { checkReleaseCollection } from "../core/collection.js";
import { validateEvent } from "../core/event.js";
import { foldLedger } from "../core/fold.js";
import { checkProductionGate } from "../core/gates.js";
import { appendEvent, readLedger } from "../core/ledger.js";
import type {
  Actor,
  Bundle,
  Environment,
  EventKind,
  FailurePhase,
  ReleaseEvent,
} from "../core/types.js";
import { buildManifest } from "../manifest/manifest.js";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags; repeated: string[] } {
  const positional: string[] = [];
  const flags: Flags = {};
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
    if (seen.has(name)) repeated.push(name);
    seen.add(name);
    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags, repeated };
}

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function requireString(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) fail(`missing required flag --${name}`);
  return value;
}

function optionalString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic event_id: sha256((release_id,bundle_digest,kind,environment,occurred_at))
 * truncated to 16 hex chars, so re-running the same command at the same occurred_at is
 * idempotent (see the schema's own event_id description) rather than a fresh duplicate line. */
function deriveEventId(
  releaseId: string,
  bundleDigestValue: string,
  kind: string,
  environment: Environment,
  occurredAt: string,
): string {
  const material = JSON.stringify([releaseId, bundleDigestValue, kind, environment, occurredAt]);
  return sha256hex(material).slice(0, 16);
}

const USAGE: Record<string, string> = {
  prepare: "release-evidence prepare --bundle <file> --ledger <file> [--actor human|ci|cli]",
  record:
    "release-evidence record <deployed|verified|failed|rolled-back|attest> --ledger <file> --release-id <id> --bundle-digest <sha256:...> " +
    "[--environment preview|staging|production] [--failure-phase deploy|verification|post_verification] [--reason <text>] " +
    "[--rollback-to <release_id>] [--staging-skipped] " +
    "[--preview-skipped --preview-skipped-code no_preview_environment_scheduled_rebuild|other] " +
    "[--attestation-digest <sha256:...>] [--attestation-ref <ref>] " +
    "[--bundle <file> (REQUIRED for `deployed --environment production`)] [--actor human|ci|cli]",
  status: "release-evidence status --ledger <file> [--release-id <id>]",
  audit: "release-evidence audit --ledger <file> --bundles <dir>",
  manifest: "release-evidence manifest <dir>",
};

/** Per-command allowlists -- an unrecognized flag or an extra positional argument is a usage
 * error (exit 2), never silently ignored (a typo like --relese-id must not succeed). */
const ALLOWED_FLAGS: Record<string, string[]> = {
  prepare: ["bundle", "ledger", "actor", "help", "h"],
  record: [
    "ledger",
    "release-id",
    "bundle-digest",
    "environment",
    "failure-phase",
    "reason",
    "rollback-to",
    "staging-skipped",
    "preview-skipped",
    "preview-skipped-code",
    "attestation-digest",
    "attestation-ref",
    "bundle",
    "actor",
    "help",
    "h",
  ],
  status: ["ledger", "release-id", "help", "h"],
  audit: ["ledger", "bundles", "help", "h"],
  manifest: ["help", "h"],
};
const MAX_POSITIONAL: Record<string, number> = {
  prepare: 0,
  record: 1,
  status: 0,
  audit: 0,
  manifest: 1,
};

function assertAllowedArgs(cmd: string, flags: Flags, positional: string[]): void {
  const allowed = new Set(ALLOWED_FLAGS[cmd] ?? []);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) fail(`unknown flag --${key} for "${cmd}"\n\nusage: ${USAGE[cmd]}`);
  }
  const max = MAX_POSITIONAL[cmd] ?? 0;
  if (positional.length > max) {
    fail(
      `too many positional arguments for "${cmd}" (got ${positional.length}, expected at most ${max})\n\nusage: ${USAGE[cmd]}`,
    );
  }
}

function printHelp(cmd?: string): void {
  if (cmd) {
    console.log(USAGE[cmd] ?? `unknown command "${cmd}"`);
    return;
  }
  console.log("release-evidence <command> [...]\n");
  for (const usage of Object.values(USAGE)) console.log(`  ${usage}`);
}

function printResultAndMaybeWarnIdempotent(
  event: ReleaseEvent,
  appended: boolean,
  extra: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ ...extra, event, appended }, null, 2));
  if (!appended)
    console.error(
      `note: event_id "${event.event_id}" was already recorded verbatim -- no new line written (idempotent replay)`,
    );
}

/** Shared append pipeline for `prepare` and `record`: skip straight to ledger.appendEvent (its
 * own idempotent/conflict handling applies) when this exact event_id was already recorded
 * verbatim -- otherwise fold the FULL ledger (existing events + this candidate) and refuse
 * (exit 3) if that's illegal anywhere, including ledger-wide checks a per-attempt fold can't
 * see (duplicate event_id, a rolled_back target that never reached production). `gateCheck`,
 * if given, runs after the fold passes and before the write -- also exit 3 on rejection. */
function appendWithLedgerWideCheck(
  ledgerPath: string,
  event: ReleaseEvent,
  gateCheck?: (priorAttemptEvents: ReleaseEvent[]) => string[],
): { result: { appended: boolean; event: ReleaseEvent }; priorAttemptEvents: ReleaseEvent[] } {
  const existingAll = readLedger(ledgerPath);
  const priorAttemptEvents = existingAll.filter(
    (e) => e.release_id === event.release_id && e.bundle_digest === event.bundle_digest,
  );

  const alreadyRecorded = existingAll.find((e) => e.event_id === event.event_id);
  if (alreadyRecorded) {
    // Not a new transition being applied -- let appendEvent's own idempotent/conflict
    // handling decide (identical content -> no-op; different content -> throws, caught by
    // main()'s top-level handler as exit 2).
    return { result: appendEvent(ledgerPath, event), priorAttemptEvents };
  }

  const { problems } = foldLedger([...existingAll, event]);
  if (problems.length > 0) {
    console.error("illegal transition, refusing to append:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(3);
  }

  if (gateCheck) {
    const gateProblems = gateCheck(priorAttemptEvents);
    if (gateProblems.length > 0) {
      console.error("production gate rejected, refusing to append:");
      for (const p of gateProblems) console.error(`  - ${p}`);
      process.exit(3);
    }
  }

  return { result: appendEvent(ledgerPath, event), priorAttemptEvents };
}

function cmdPrepare(flags: Flags): void {
  const bundlePath = requireString(flags, "bundle");
  const ledgerPath = requireString(flags, "ledger");
  const actor = (optionalString(flags, "actor") ?? "cli") as Actor;

  const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as Bundle;
  const bundleReasons = validateBundle(bundle);
  if (bundleReasons.length > 0) {
    console.error("bundle failed validation:");
    for (const r of bundleReasons) console.error(`  - ${r}`);
    process.exit(2);
  }

  const digest = computeBundleDigest(bundle);
  const occurredAt = nowIso();
  const event: ReleaseEvent = {
    schema_version: "release-evidence/v0",
    event_id: deriveEventId(bundle.release_id, digest, "prepared", null, occurredAt),
    release_id: bundle.release_id,
    kind: "prepared",
    environment: null,
    occurred_at: occurredAt,
    actor,
    bundle_digest: digest,
  };

  const { result } = appendWithLedgerWideCheck(ledgerPath, event);
  printResultAndMaybeWarnIdempotent(result.event, result.appended, { bundle_digest: digest });
}

const RECORD_KIND_MAP: Record<string, EventKind> = {
  deployed: "deployed",
  verified: "verified",
  failed: "failed",
  "rolled-back": "rolled_back",
  attest: "attested",
};

function cmdRecord(kindArg: string, flags: Flags): void {
  const kind = RECORD_KIND_MAP[kindArg];
  if (!kind)
    fail(
      `unknown record kind "${kindArg}" (expected one of: deployed|verified|failed|rolled-back|attest)`,
    );

  const ledgerPath = requireString(flags, "ledger");
  const releaseId = requireString(flags, "release-id");
  const bundleDigestValue = requireString(flags, "bundle-digest");
  const actor = (optionalString(flags, "actor") ?? "cli") as Actor;
  const occurredAt = nowIso();

  let environment: Environment = null;
  if (kind === "attested") {
    if (flags.environment !== undefined)
      fail("--environment is not allowed on `attest` (attested events are environment-less)");
  } else {
    environment = requireString(flags, "environment") as Environment;
  }

  const event: ReleaseEvent = {
    schema_version: "release-evidence/v0",
    event_id: deriveEventId(releaseId, bundleDigestValue, kind, environment, occurredAt),
    release_id: releaseId,
    kind,
    environment,
    occurred_at: occurredAt,
    actor,
    bundle_digest: bundleDigestValue,
  };

  if (kind === "failed") {
    event.failure_phase = requireString(flags, "failure-phase") as FailurePhase;
    event.reason = requireString(flags, "reason");
  }
  if (kind === "rolled_back") {
    event.rollback_to_release_id = requireString(flags, "rollback-to");
    event.reason = requireString(flags, "reason");
  }
  if (flags["staging-skipped"]) {
    if (!(kind === "deployed" && environment === "production")) {
      fail("--staging-skipped is only legal on `record deployed --environment production`");
    }
    event.staging_skipped = true;
  }
  if (flags["preview-skipped"]) {
    if (!(kind === "deployed" && environment === "production")) {
      fail("--preview-skipped is only legal on `record deployed --environment production`");
    }
    event.preview_skipped = true;
    event.preview_skipped_code = requireString(flags, "preview-skipped-code") as NonNullable<
      ReleaseEvent["preview_skipped_code"]
    >;
  }
  if (kind === "attested") {
    event.attestation = {
      kind: "lane_done_overlay",
      digest: requireString(flags, "attestation-digest"),
    };
    const ref = optionalString(flags, "attestation-ref");
    if (ref !== undefined) event.attestation.ref = ref;
  }

  const schemaReasons = validateEvent(event);
  if (schemaReasons.length > 0) {
    console.error("event failed schema validation, refusing to append:");
    for (const r of schemaReasons) console.error(`  - ${r}`);
    process.exit(2);
  }

  const isProductionDeploy = kind === "deployed" && environment === "production";

  // A deploy to production REQUIRES the real bundle (no silent "gate not checked" path): the
  // lane_done_overlay / review.decision gates cannot be evaluated without it. --bundle-digest
  // alone is a claim; --bundle is the evidence that claim is checked against.
  let productionBundle: Bundle | undefined;
  if (isProductionDeploy) {
    const bundlePath = requireString(flags, "bundle");
    productionBundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as Bundle;
    const bundleReasons = validateBundle(productionBundle);
    if (bundleReasons.length > 0) {
      console.error(`--bundle "${bundlePath}" failed validation:`);
      for (const r of bundleReasons) console.error(`  - ${r}`);
      process.exit(2);
    }
    const actualDigest = computeBundleDigest(productionBundle);
    if (actualDigest !== bundleDigestValue) {
      fail(
        `--bundle "${bundlePath}" has JCS digest ${actualDigest}, which does not match --bundle-digest ${bundleDigestValue}`,
      );
    }
    if (productionBundle.release_id !== releaseId) {
      fail(
        `--bundle "${bundlePath}" has release_id "${productionBundle.release_id}", which does not match --release-id "${releaseId}"`,
      );
    }
  }

  const { result } = appendWithLedgerWideCheck(
    ledgerPath,
    event,
    isProductionDeploy && productionBundle
      ? (priorAttemptEvents) => checkProductionGate(productionBundle as Bundle, priorAttemptEvents)
      : undefined,
  );
  printResultAndMaybeWarnIdempotent(result.event, result.appended);
}

function cmdStatus(flags: Flags): void {
  const ledgerPath = requireString(flags, "ledger");
  const releaseIdFilter = optionalString(flags, "release-id");
  const events = readLedger(ledgerPath);

  // A contract-violating line must not be silently folded (it could produce a misleading
  // "illegal_transition" instead of the real problem: this ledger has a record that was never
  // legal in the first place).
  const schemaProblems: string[] = [];
  events.forEach((ev, i) => {
    const reasons = validateEvent(ev);
    if (reasons.length > 0) {
      const eventId =
        typeof (ev as { event_id?: unknown }).event_id === "string"
          ? (ev as ReleaseEvent).event_id
          : "?";
      schemaProblems.push(
        `line ${i + 1} (event_id ${JSON.stringify(eventId)}) violates release-event.schema.json: ${reasons.join("; ")}`,
      );
    }
  });
  if (schemaProblems.length > 0) {
    console.error("ledger contains contract-violating line(s), refusing to fold:");
    for (const p of schemaProblems) console.error(`  - ${p}`);
    process.exit(2);
  }

  // Folded over the WHOLE ledger, unfiltered: a rollback's "did the target reach production
  // earlier" check needs every attempt in scope, not just the ones matching --release-id, or
  // a legitimate rollback would false-positive as dangling once filtered down.
  const { attempts, problems } = foldLedger(events);
  const attemptSummaries = [...attempts.entries()]
    .filter(([key]) => {
      if (!releaseIdFilter) return true;
      return key.slice(0, key.indexOf(" ")) === releaseIdFilter;
    })
    .map(([key, result]) => {
      const spaceIdx = key.indexOf(" ");
      return {
        release_id: key.slice(0, spaceIdx),
        bundle_digest: key.slice(spaceIdx + 1),
        state: result.state,
        reached_production: result.reachedProduction,
        problems: result.problems,
      };
    });

  console.log(JSON.stringify({ attempts: attemptSummaries, ledger_problems: problems }, null, 2));
  if (problems.length > 0 || attemptSummaries.some((a) => a.problems.length > 0)) process.exit(1);
}

function cmdAudit(flags: Flags): void {
  const ledgerPath = requireString(flags, "ledger");
  const bundlesDir = requireString(flags, "bundles");

  const events = readLedger(ledgerPath);
  const bundleFiles = readdirSync(bundlesDir).filter((f) => f.endsWith(".json"));
  const bundles = bundleFiles.map(
    (f) => JSON.parse(readFileSync(path.join(bundlesDir, f), "utf-8")) as Bundle,
  );

  const problems = checkReleaseCollection({ bundles, events });
  if (problems.length === 0) {
    console.log(
      `audit clean: ${bundles.length} bundle(s), ${events.length} event(s), all checks passed.`,
    );
    process.exit(0);
  }
  console.error(`audit found ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

function cmdManifest(dir: string): void {
  const { manifest, digest } = buildManifest(dir);
  console.log(JSON.stringify({ digest, manifest }, null, 2));
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags, repeated } = parseArgs(rest);

  if (!cmd) {
    printHelp();
    process.exit(2);
  }
  if (!(cmd in USAGE)) {
    console.error(`unknown command "${cmd}"\n`);
    printHelp();
    process.exit(2);
  }
  if (repeated.length > 0) {
    fail(`flag --${repeated[0]} was given more than once`);
  }
  if (flags.help || flags.h) {
    printHelp(cmd);
    process.exit(0);
  }
  assertAllowedArgs(cmd, flags, positional);

  switch (cmd) {
    case "prepare":
      cmdPrepare(flags);
      return;
    case "record": {
      const kindArg = positional[0];
      if (!kindArg) fail(`usage: ${USAGE.record}`);
      cmdRecord(kindArg, flags);
      return;
    }
    case "status":
      cmdStatus(flags);
      return;
    case "audit":
      cmdAudit(flags);
      return;
    case "manifest": {
      const dir = positional[0];
      if (!dir) fail(`usage: ${USAGE.manifest}`);
      cmdManifest(dir);
      return;
    }
    default:
      fail(`unknown command "${cmd}"`);
  }
}

try {
  main();
} catch (err) {
  // 環境不備 (RELEASE_EVIDENCE_CONTRACTS_DIR 未設定など) や読めないファイルは利用者への
  // メッセージであって stack trace ではない。exit 2 = 使い方/環境の誤り (3 = 遷移/gate 拒否)。
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
