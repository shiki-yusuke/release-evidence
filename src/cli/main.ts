#!/usr/bin/env node
// release-evidence CLI: prepare (seal a bundle + record `prepared`), record <kind> (append one
// ledger transition, refusing anything the fold/gates find illegal), status (fold and print),
// audit (full release-collection check against a ledger + a directory of bundle files), and
// manifest (compute a static_site content manifest and its digest). No subcommand writes
// anything to the ledger without first checking legality -- an illegal transition exits 3 and
// leaves the ledger untouched (ledger.ts's own schema check would refuse it anyway, but the
// fold/gate check runs first so the failure reason is the actual state-machine violation, not
// a generic schema error).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sha256hex } from "#vendor/jcs.mjs";
import { bundleDigest as computeBundleDigest, validateBundle } from "../core/bundle.js";
import { checkReleaseCollection } from "../core/collection.js";
import { validateEvent } from "../core/event.js";
import { foldAttempt, foldLedger } from "../core/fold.js";
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

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
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
    "[--rollback-to <release_id>] [--staging-skipped] [--attestation-digest <sha256:...>] [--bundle <file>] [--actor human|ci|cli]",
  status: "release-evidence status --ledger <file> [--release-id <id>]",
  audit: "release-evidence audit --ledger <file> --bundles <dir>",
  manifest: "release-evidence manifest <dir>",
};

function printHelp(cmd?: string): void {
  if (cmd) {
    const usage = USAGE[cmd];
    console.log(usage ?? `unknown command "${cmd}"`);
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

  const existingAttempt = readLedger(ledgerPath).filter(
    (e) => e.release_id === event.release_id && e.bundle_digest === event.bundle_digest,
  );
  const { problems } = foldAttempt(event.release_id, event.bundle_digest, [
    ...existingAttempt,
    event,
  ]);
  if (problems.length > 0) {
    console.error("illegal transition, refusing to append:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(3);
  }

  const result = appendEvent(ledgerPath, event);
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

  const existingAll = readLedger(ledgerPath);
  const existingAttempt = existingAll.filter(
    (e) => e.release_id === releaseId && e.bundle_digest === bundleDigestValue,
  );
  const { problems: transitionProblems } = foldAttempt(releaseId, bundleDigestValue, [
    ...existingAttempt,
    event,
  ]);
  if (transitionProblems.length > 0) {
    console.error("illegal transition, refusing to append:");
    for (const p of transitionProblems) console.error(`  - ${p}`);
    process.exit(3);
  }

  if (kind === "deployed" && environment === "production") {
    // The production gate (lane_done_overlay attestation / review.decision) needs the real
    // bundle, which `record`'s own flag set does not carry -- an optional --bundle lets a
    // caller opt into the full check; without it we can only have verified the transition
    // graph above, and we say so rather than silently skipping a check the protocol requires.
    const bundlePath = optionalString(flags, "bundle");
    if (bundlePath) {
      const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as Bundle;
      const gateProblems = checkProductionGate(bundle, existingAttempt);
      if (gateProblems.length > 0) {
        console.error("production gate rejected, refusing to append:");
        for (const p of gateProblems) console.error(`  - ${p}`);
        process.exit(3);
      }
    } else {
      console.error(
        "warning: no --bundle given -- only the transition graph was checked; lane_done_overlay / review.decision production gates were NOT verified",
      );
    }
  }

  const result = appendEvent(ledgerPath, event);
  printResultAndMaybeWarnIdempotent(result.event, result.appended);
}

function cmdStatus(flags: Flags): void {
  const ledgerPath = requireString(flags, "ledger");
  const releaseIdFilter = optionalString(flags, "release-id");
  const events = readLedger(ledgerPath);
  const filtered = releaseIdFilter
    ? events.filter((e) => e.release_id === releaseIdFilter)
    : events;

  const { attempts, problems } = foldLedger(filtered);
  const attemptSummaries = [...attempts.entries()].map(([key, result]) => {
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
  const { positional, flags } = parseArgs(rest);

  if (!cmd) {
    printHelp();
    process.exit(2);
  }
  if (flags.help || flags.h) {
    printHelp(cmd);
    process.exit(0);
  }

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
      fail(`unknown command "${cmd}"\n\n${USAGE[cmd] ?? ""}`);
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
