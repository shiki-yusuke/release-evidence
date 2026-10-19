#!/usr/bin/env node
// D13 retrospective dry-run preflight (docs/retrospective/d13-2026-08-window/README.md).
//
//   node scripts/retrospective-d13-preflight.mjs --harvester <path> --releases <releases.json>
//                                                [--ref origin/metrics-data]
//
// Recomputes, deterministically and from the harvester's git ref ONLY, whether each release in
// <releases.json> has the inputs an evaluation would need, and compares the result with what
// <releases.json> claims. The harvester's working tree is never read: every byte comes from
// `git rev-parse` / `git ls-tree -r --name-only` / `git show <ref>:<path>` against a single
// resolved commit, which is printed in the output.
//
// This script never imports or spawns the evaluator -- the only child process it starts is git
// (resolved from $GIT when set, else from PATH). A release that fails preflight is
// `not_evaluable`: a namespace of its own, never mixed with the evaluator's evaluation_status.
//
// Exit codes: 0 = recomputation matches <releases.json>; 1 = differences (printed under
// "diffs"); 2 = usage / unreadable harvester / unreadable releases file. There is no
// "skipped" success.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { canonicalize, sha256hex } from "../vendor/playbook-shared/jcs.mjs";

const SCHEMA_VERSION = "d13-retrospective/v0";
const LEDGER_PATH = "release-evidence/release-events.jsonl";
const BUNDLE_PATH_PATTERN = /^release-evidence\/bundles\/bundle-[0-9a-f]+\.json$/;
const VERIFICATION_METHOD = "harvester_ledger_and_bundles";
const STATUSES = ["evaluable", "not_evaluable"];
const RECEIPT_NOT_EMITTED = "no_receipt_emitted";

// The eleven releases of the D13 window, in order. releases.json must list exactly these
// (index 1..11); anything else is not the D13 document and is refused (exit 2) rather than
// recomputed, so a swapped-in ID can never pass as one of the eleven.
const D13_RELEASE_IDS = [
  "spec-lane@0.4.0",
  "spec-lane@0.5.0",
  "spec-lane@0.5.1",
  "spec-lane@0.5.2",
  "spec-lane@0.6.0",
  "spec-lane@0.7.0",
  "evidence-docs@0.1.0",
  "evidence-docs@0.2.0",
  "agent-cost@0.1.0",
  "release-evidence@0.1.0",
  "agent-metrics-dashboard@32572501427-1",
];

// Reason vocabulary, in canonical order. Each non-bundle reason lists the record keys whose
// appearance counts as a record of that input, and the tree-path pattern that would count as a
// dedicated file for it. A key counts FOR A RELEASE only when it appears inside a record that is
// attributed to that release (one of its ledger events, or its bundle body). A key or path found
// anywhere else on the ref is never applied to any release's status: it is reported as an
// unattributed hit and makes the run fail (exit 1) for a human to resolve. An unrelated record
// can therefore stop the run, but can never turn a release "evaluable".
const REASONS = [
  { code: "bundle_absent" },
  {
    code: "selection_manifest_absent",
    keys: ["selection_manifest_digest"],
    path: /selection[-_]?manifest/i,
  },
  {
    code: "policy_snapshot_absent",
    keys: ["policy_snapshot", "policy_digest"],
    path: /policy[-_]?snapshot/i,
  },
  { code: "effective_risk_unrecorded", keys: ["effective_risk"], path: /effective[-_]?risk/i },
  {
    code: "contract_pin_unrecorded",
    keys: ["playbook_commit", "contract_pin"],
    path: /contract[-_]?pin/i,
  },
];
const REASON_CODES = REASONS.map((r) => r.code);

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { ref: "origin/metrics-data" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--harvester", "--releases", "--ref"].includes(flag)) {
      throw new UsageError(`unknown argument: ${flag}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${flag} requires a value`);
    }
    args[flag.slice(2)] = value;
    i++;
  }
  if (!args.harvester) throw new UsageError("--harvester <path> is required");
  if (!args.releases) throw new UsageError("--releases <releases.json> is required");
  return args;
}

function makeGit(harvester) {
  // Only `git` from PATH is ever executed; there is no override.
  return (...gitArgs) =>
    execFileSync("git", ["-C", harvester, ...gitArgs], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function openHarvester(harvester, ref) {
  try {
    if (!statSync(harvester).isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new UsageError(`--harvester "${harvester}" is not readable: ${err.message}`);
  }
  const git = makeGit(harvester);
  let commit;
  try {
    commit = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).trim();
  } catch (err) {
    throw new UsageError(
      `--harvester "${harvester}": cannot resolve ref "${ref}" (${String(err.stderr || err.message).trim()})`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new UsageError(`ref "${ref}" resolved to an unexpected value: ${commit}`);
  }
  // Every later read is pinned to the resolved commit, not the (movable) ref name.
  const files = git("ls-tree", "-r", "--name-only", commit)
    .split("\n")
    .filter((line) => line !== "")
    .sort();
  const show = (path) => git("show", `${commit}:${path}`);
  return { commit, files, show };
}

function parseJsonRecords(path, text) {
  if (path.endsWith(".jsonl")) {
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch (err) {
          throw new UsageError(`${path}:${i + 1}: not JSON (${err.message})`);
        }
      });
  }
  try {
    return [JSON.parse(text)];
  } catch (err) {
    throw new UsageError(`${path}: not JSON (${err.message})`);
  }
}

function collectKeys(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
}

function recordDigest(content) {
  return `sha256:${sha256hex(canonicalize(content))}`;
}

function scanHarvester(repo) {
  if (!repo.files.includes(LEDGER_PATH)) {
    throw new UsageError(`ledger ${LEDGER_PATH} is not present on ${repo.commit}`);
  }
  const ledger = parseJsonRecords(LEDGER_PATH, repo.show(LEDGER_PATH));

  const bundles = repo.files
    .filter((path) => BUNDLE_PATH_PATTERN.test(path))
    .map((path) => {
      const [content] = parseJsonRecords(path, repo.show(path));
      return { path, content, digest: recordDigest(content) };
    });

  // Content inspection of every JSON / JSONL record on the ref (including the ledger and the
  // bundles), plus a tree-path check, for the four non-bundle inputs.
  const keyHits = [];
  const pathHits = [];
  const wanted = new Set(REASONS.flatMap((r) => r.keys ?? []));
  for (const path of repo.files) {
    for (const reason of REASONS) {
      if (reason.path?.test(path)) pathHits.push({ path, reason: reason.code });
    }
    if (!path.endsWith(".json") && !path.endsWith(".jsonl")) continue;
    const keys = new Set();
    for (const record of parseJsonRecords(path, repo.show(path))) collectKeys(record, keys);
    for (const key of [...keys].sort()) {
      if (wanted.has(key)) keyHits.push({ path, key });
    }
  }
  return { ledger, bundles, keyHits, pathHits };
}

function recompute(release, scan, diffs) {
  const id = release.release_id;
  const tag = `#${release.index} ${id}`;
  const events = scan.ledger.filter((e) => e?.release_id === id);

  const matching = scan.bundles.filter((b) => b.content?.release_id === id);
  if (matching.length > 1) {
    diffs.push(`${tag}: ${matching.length} bundles carry this release_id (${matching.map((b) => b.path).join(", ")})`);
  }
  const bundle = matching[0] ?? null;
  if (bundle) {
    const source = bundle.content.source ?? {};
    if (source.repo !== release.repo) {
      diffs.push(`${tag}: bundle source.repo is ${JSON.stringify(source.repo)}, releases.json says ${release.repo}`);
    }
    if (release.ref?.commit && !String(source.commit_sha ?? "").startsWith(release.ref.commit)) {
      diffs.push(`${tag}: bundle source.commit_sha ${source.commit_sha} does not start with ref.commit ${release.ref.commit}`);
    }
    for (const e of events) {
      if (e.bundle_digest !== bundle.digest) {
        diffs.push(`${tag}: ledger event ${e.event_id} names ${e.bundle_digest}, bundle recomputes to ${bundle.digest}`);
      }
    }
  } else if (release.ref?.commit) {
    // Guard against a bundle that exists for this source under a different release_id.
    const alias = scan.bundles.filter(
      (b) =>
        b.content?.source?.repo === release.repo &&
        String(b.content?.source?.commit_sha ?? "").startsWith(release.ref.commit),
    );
    for (const b of alias) {
      diffs.push(`${tag}: ${b.path} records this repo+commit under release_id ${b.content.release_id}`);
    }
  }

  // Inputs count as recorded for THIS release only inside records attributed to it.
  const attributedKeys = new Set();
  for (const record of [...events, ...(bundle ? [bundle.content] : [])]) collectKeys(record, attributedKeys);
  const inputRecorded = Object.fromEntries(
    REASONS.filter((r) => r.keys).map((r) => [r.code, r.keys.some((k) => attributedKeys.has(k))]),
  );
  const reasons = REASONS.filter((r) =>
    r.code === "bundle_absent" ? bundle === null : !inputRecorded[r.code],
  ).map((r) => r.code);
  const status = reasons.length === 0 ? "evaluable" : "not_evaluable";
  return {
    index: release.index,
    release_id: id,
    ledger: { events: events.length },
    bundle: bundle
      ? { present: true, path: bundle.path, digest: bundle.digest }
      : { present: false, path: null, digest: null },
    selection_manifest: { present: inputRecorded.selection_manifest_absent },
    policy_snapshot: { present: inputRecorded.policy_snapshot_absent },
    preflight: status === "not_evaluable" ? { status, reasons, receipt: RECEIPT_NOT_EMITTED } : { status, reasons },
  };
}

function compare(release, got, ref, commit, diffs) {
  const tag = `#${release.index} ${release.release_id}`;
  const check = (label, claimed, actual) => {
    if (JSON.stringify(claimed) !== JSON.stringify(actual)) {
      diffs.push(`${tag}: ${label}: releases.json ${JSON.stringify(claimed)} != recomputed ${JSON.stringify(actual)}`);
    }
  };
  check("ledger.events", release.ledger?.events, got.ledger.events);
  check("bundle", release.bundle, got.bundle);
  check("selection_manifest", release.selection_manifest, got.selection_manifest);
  check("policy_snapshot", release.policy_snapshot, got.policy_snapshot);
  const pf = release.preflight ?? {};
  if (!STATUSES.includes(pf.status)) diffs.push(`${tag}: preflight.status ${JSON.stringify(pf.status)} is not one of ${STATUSES.join("/")}`);
  for (const r of pf.reasons ?? []) {
    if (!REASON_CODES.includes(r)) diffs.push(`${tag}: unknown reason ${JSON.stringify(r)}`);
  }
  check("preflight.status", pf.status, got.preflight.status);
  check("preflight.reasons", pf.reasons, got.preflight.reasons);
  // An evaluable release's receipt can only come from an actual evaluator run, which this
  // script never performs -- only the not_evaluable side is checked here.
  if (got.preflight.status === "not_evaluable") check("preflight.receipt", pf.receipt, RECEIPT_NOT_EMITTED);
  check("verification", release.verification, { method: VERIFICATION_METHOD, ref, commit });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let doc;
  try {
    doc = JSON.parse(readFileSync(args.releases, "utf-8"));
  } catch (err) {
    throw new UsageError(`--releases "${args.releases}" is not readable JSON: ${err.message}`);
  }
  if (doc?.schema_version !== SCHEMA_VERSION || !Array.isArray(doc.releases)) {
    throw new UsageError(`--releases: expected schema_version ${SCHEMA_VERSION} with a releases array`);
  }
  const listedIds = doc.releases.map((r) => r?.release_id);
  const listedIndexes = doc.releases.map((r) => r?.index);
  if (
    JSON.stringify(listedIds) !== JSON.stringify(D13_RELEASE_IDS) ||
    JSON.stringify(listedIndexes) !== JSON.stringify(D13_RELEASE_IDS.map((_, i) => i + 1))
  ) {
    throw new UsageError(
      `--releases: not the D13 window document (expected exactly ${D13_RELEASE_IDS.length} releases, in order: ${D13_RELEASE_IDS.join(", ")})`,
    );
  }

  const repo = openHarvester(args.harvester, args.ref);
  const scan = scanHarvester(repo);
  const diffs = [];
  const releases = doc.releases.map((release) => {
    const got = recompute(release, scan, diffs);
    compare(release, got, args.ref, repo.commit, diffs);
    return got;
  });

  // Any input key or dedicated path found outside a record attributed to one of the eleven
  // releases is unattributed: it is never applied to a status, and it fails the run.
  const listed = new Set(D13_RELEASE_IDS);
  for (const h of scan.pathHits) diffs.push(`unattributed path for ${h.reason}: ${h.path}`);
  const attributable = (path) => path === LEDGER_PATH || BUNDLE_PATH_PATTERN.test(path);
  for (const h of scan.keyHits) {
    if (!attributable(h.path)) {
      diffs.push(`unattributed key ${h.key} in ${h.path} (not a ledger / bundle record)`);
      continue;
    }
    for (const record of parseJsonRecords(h.path, repo.show(h.path))) {
      const keys = new Set();
      collectKeys(record, keys);
      if (keys.has(h.key) && !listed.has(record?.release_id)) {
        diffs.push(`unattributed key ${h.key} in ${h.path} (release_id ${JSON.stringify(record?.release_id ?? null)} is not in the D13 window)`);
      }
    }
  }

  const out = {
    schema_version: "d13-retrospective-preflight/v0",
    harvester: { ref: args.ref, commit: repo.commit, files: repo.files.length },
    evaluator_invoked: false,
    ledger_events_total: scan.ledger.length,
    bundles_total: scan.bundles.length,
    input_record_hits: { keys: scan.keyHits, paths: scan.pathHits },
    summary: {
      releases: releases.length,
      not_evaluable: releases.filter((r) => r.preflight.status === "not_evaluable").length,
      evaluable: releases.filter((r) => r.preflight.status === "evaluable").length,
    },
    releases,
    diffs,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return diffs.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`retrospective-d13-preflight: ${err instanceof UsageError ? err.message : err.stack}\n`);
  process.exitCode = 2;
}
