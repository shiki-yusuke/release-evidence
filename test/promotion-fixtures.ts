// Shared fixtures for test/promotion-*.test.ts (and, compiled to dist/test/, for the concurrent
// worker in test/fixtures/promotion-authorize-worker.mjs). No vitest import here on purpose.
// Git: a bare repo in a mkdtemp dir is the remote. GitHub: an in-memory fake behind an injected
// `fetch` -- nothing here touches the network.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalize, sha256hex } from "#vendor/jcs.mjs";
import { bundleDigest } from "../src/core/bundle.js";
import { buildManifest, writeReleaseManifest } from "../src/manifest/manifest.js";
import { computeApprovalEventId } from "../src/promotion/authority.js";
import type { Flags, PromoteDeps } from "../src/promotion/commands.js";
import type { FetchFn } from "../src/promotion/provider.js";
import type { ApprovalEvent } from "../src/promotion/types.js";
import { tarOfDir } from "./tar-writer.js";
import { buildZip } from "./zip-writer.js";

export const REPO = "acme/site";
export const HEAD_SHA = "a".repeat(40);
export const RUN_ID = "1001";
export const EXECUTOR_RUN_ID = "2002";
export const T0 = "2026-10-16T12:00:00Z";
export const SHA = (c: string) => `sha256:${c.repeat(64).slice(0, 64)}`;
export const jcs = (v: unknown) => `sha256:${sha256hex(canonicalize(v))}`;
export const addSeconds = (iso: string, s: number) =>
  new Date(Date.parse(iso) + s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    input: input ?? "",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@invalid",
    },
  });
}

export function makeApproval(fields: {
  kind?: ApprovalEvent["kind"];
  subject: ApprovalEvent["subject"];
  occurred_at?: string;
  expires_at?: string;
  revoked_approval_event_id?: string;
  recorded_after_side_effect?: boolean;
}): ApprovalEvent {
  const kind = fields.kind ?? "approval_granted";
  const ev: Record<string, unknown> = {
    schema_version: "release-approval/v0",
    kind,
    subject: fields.subject,
    principal: {
      principal_id: "release-captain-01",
      issuer: "github-oidc",
      role_snapshot: "approver",
    },
    occurred_at: fields.occurred_at ?? "2026-10-16T00:00:00Z",
  };
  if (kind === "approval_granted" || kind === "break_glass_approve") {
    ev.expires_at = fields.expires_at ?? "2026-10-17T00:00:00Z";
  }
  if (kind === "approval_revoked") ev.revoked_approval_event_id = fields.revoked_approval_event_id;
  if (kind === "break_glass_approve") {
    ev.bypassed_predicate_ids = ["review_admissibility"];
    ev.incident_ref = "INC-1";
    if (fields.recorded_after_side_effect !== undefined) {
      ev.recorded_after_side_effect = fields.recorded_after_side_effect;
    }
  }
  ev.event_id = computeApprovalEventId(ev);
  return ev as unknown as ApprovalEvent;
}

interface FakeArtifact {
  id: number;
  name: string;
  expired: boolean;
  digest: string | null;
  workflow_run: { id: number };
}
export interface FakeDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  created_at: string;
  payload: unknown;
  description: string | null;
}
export interface FakeStatus {
  id: number;
  state: string;
  created_at: string;
}

/** Serializable fake GitHub state (also handed to the worker process as JSON). */
export interface FakeState {
  repository: string;
  now: string;
  nowQueue: string[];
  runs: Record<string, { status: string; conclusion: string | null; head_sha: string }>;
  artifacts: Record<string, FakeArtifact[]>;
  deployments: FakeDeployment[];
  statuses: Record<string, FakeStatus[]>;
  pagesList: "unsupported" | "error" | FakeDeployment[];
  deploymentsListFails: boolean;
  create: "created" | "timeout" | "5xx" | "reset-after-accept" | "rejected";
  nextDeploymentId: number;
  posts: number;
  postBodies: unknown[];
  live: Record<string, string>;
}

export function makeFetch(st: FakeState): FetchFn {
  return async (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const now = st.nowQueue.length > 0 ? (st.nowQueue.shift() as string) : st.now;
    const reply = (status: number, body: unknown) =>
      new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { date: new Date(now).toUTCString(), "content-type": "application/json" },
      });
    const prefix = `/repos/${st.repository}`;
    if (u.hostname !== "api.test") {
      const body = st.live[url];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    }
    const p = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : "#";
    const page = Number(u.searchParams.get("page") ?? "1");
    const paged = <T>(items: T[]) => (page === 1 ? items : []);
    let m: RegExpExecArray | null;
    if (p === "" && method === "GET") return reply(200, { full_name: st.repository });
    m = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(p);
    if (m) {
      const run = st.runs[`${m[1]}/${m[2]}`];
      if (!run) return reply(404, { message: "Not Found" });
      return reply(200, { id: Number(m[1]), run_attempt: Number(m[2]), ...run });
    }
    m = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(p);
    if (m) {
      return reply(200, { artifacts: paged(st.artifacts[m[1] as string] ?? []) });
    }
    m = /^\/actions\/artifacts\/(\d+)$/.exec(p);
    if (m) {
      const a = Object.values(st.artifacts)
        .flat()
        .find((x) => x.id === Number(m?.[1]));
      return a ? reply(200, a) : reply(404, { message: "Not Found" });
    }
    if (p === "/pages/deployments" && method === "POST") {
      st.posts++;
      st.postBodies.push(JSON.parse(String(init?.body)));
      const body = JSON.parse(String(init?.body)) as { pages_build_version: string };
      const create = () => {
        const id = st.nextDeploymentId++;
        st.deployments.push({
          id,
          sha: body.pages_build_version.split(":")[0] as string,
          ref: body.pages_build_version,
          environment: "github-pages",
          created_at: now,
          payload: {},
          description: null,
        });
        return id;
      };
      if (st.create === "timeout") throw new DOMException("timed out", "TimeoutError");
      if (st.create === "5xx") return reply(502, { message: "bad gateway" });
      if (st.create === "rejected") return reply(422, { message: "invalid" });
      const id = create();
      if (st.create === "reset-after-accept") throw new TypeError("fetch failed");
      return reply(200, { id, status_url: `https://api.test/status/${id}` });
    }
    if (p === "/pages/deployments" && method === "GET") {
      if (st.pagesList === "unsupported") return reply(404, { message: "Not Found" });
      if (st.pagesList === "error") return reply(403, { message: "Forbidden" });
      return reply(200, paged(st.pagesList));
    }
    m = /^\/deployments\/(\d+)\/statuses$/.exec(p);
    if (m) {
      return reply(200, paged(st.statuses[m[1] as string] ?? []));
    }
    m = /^\/deployments\/(\d+)$/.exec(p);
    if (m) {
      const d = st.deployments.find((x) => x.id === Number(m?.[1]));
      return d ? reply(200, d) : reply(404, { message: "Not Found" });
    }
    if (p === "/deployments") {
      if (st.deploymentsListFails) return reply(500, { message: "boom" });
      const env = u.searchParams.get("environment");
      // GitHub lists deployments newest first (created_at, then id, descending).
      const list = st.deployments
        .filter((d) => d.environment === env)
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
      return reply(200, paged(list));
    }
    return reply(404, { message: `unrouted ${method} ${p}` });
  };
}

export interface Sandbox {
  root: string;
  remote: string;
  ledger: string;
  authority: string;
  configPath: string;
  siteDir: string;
  archivePath: string;
  pagesArchivePath: string;
  tokenPath: string;
  /** Zip of `release-evidence-out-<RUN_ID>-1` (bundle.json + receipt.json), whose sha256 is the
   * artifact digest the fake Actions API reports. */
  evidenceArchivePath: string;
  bundle: Record<string, unknown>;
  receipt: Record<string, unknown>;
  subject: ApprovalEvent["subject"];
  state: FakeState;
  common: Flags;
}

export function newLedgerClone(sb: Pick<Sandbox, "root" | "remote">, name: string): string {
  const dir = path.join(sb.root, name);
  mkdirSync(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["remote", "add", "origin", sb.remote]);
  return dir;
}

export function writeAuthority(sb: Sandbox, events: ApprovalEvent[]): void {
  const rel = path.join("release-approval", REPO.replace("/", "--"));
  mkdirSync(path.join(sb.authority, rel), { recursive: true });
  writeFileSync(
    path.join(sb.authority, rel, "events.jsonl"),
    events.map((e) => `${JSON.stringify(e)}\n`).join(""),
  );
  git(sb.authority, ["add", "-A"]);
  git(sb.authority, ["commit", "-q", "--allow-empty", "-m", "authority"]);
}

/** The Pages artifact zip as upload-pages-artifact makes it: one top-level artifact.tar of dir. */
export function pagesZipOf(dir: string): Buffer {
  return buildZip([{ name: "artifact.tar", data: tarOfDir(dir), method: 8 }]);
}

/** Replaces the executor's Pages artifact archive (file + the digest the fake API reports). */
export function writePagesArchive(sb: Sandbox, zip: Buffer): string {
  writeFileSync(sb.pagesArchivePath, zip);
  const digest = sha256Bytes(zip);
  for (const a of sb.state.artifacts[EXECUTOR_RUN_ID] ?? []) a.digest = digest;
  return digest;
}

export function sha256Bytes(text: string | Buffer): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function makeSandbox(
  overrides: { settle_window_s?: number; max_cas_retries?: number } = {},
): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "release-evidence-promotion-"));
  const remote = path.join(root, "remote.git");
  git(root, ["init", "-q", "--bare", remote]);
  const ledger = newLedgerClone({ root, remote }, "ledger");
  const authority = path.join(root, "authority");
  mkdirSync(authority);
  git(authority, ["init", "-q", "-b", "main"]);
  git(authority, ["commit", "-q", "--allow-empty", "-m", "init"]);

  const configPath = path.join(root, "promotion.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      remote_url: remote,
      ref: "refs/heads/promotion-ledger",
      ledger_path: "promotion-events.jsonl",
      authority_path_template: "release-approval/<repository-slug>/events.jsonl",
      expiry_safety_window_s: 900,
      settle_window_s: overrides.settle_window_s ?? 3600,
      reconcile_lookback_s: 300,
      max_cas_retries: overrides.max_cas_retries ?? 5,
    }),
  );

  const siteDir = path.join(root, "site");
  mkdirSync(siteDir);
  writeFileSync(path.join(siteDir, "index.html"), "<h1>hello</h1>\n");
  const { manifest, digest } = buildManifest(siteDir);
  const written = writeReleaseManifest(siteDir, manifest);
  const archivePath = path.join(root, "site-dist.zip");
  writeFileSync(archivePath, "zip-bytes-of-site-dist");
  const pagesArchivePath = path.join(root, "github-pages.zip");
  writeFileSync(pagesArchivePath, pagesZipOf(siteDir));
  const tokenPath = path.join(root, "oidc-token");
  writeFileSync(tokenPath, "SECRET-OIDC-TOKEN\n");

  const bundle = {
    schema_version: "release-evidence/v0",
    release_id: "site@1.0.0",
    source: {
      repo: REPO,
      commit_sha: HEAD_SHA,
      tree_digest: "c".repeat(40),
      resolution: "git_tree",
    },
    lane_ref: null,
    lane_ref_omitted: { code: "other", note: "test" },
    review: null,
    review_omitted: { code: "other", note: "test" },
    artifacts: [
      {
        kind: "static_site",
        digest,
        content_manifest_digest: written.digest,
        artifact_ref: {
          registry: "github-pages",
          package: REPO,
          version: "1.0.0",
          verifiability: "requires_fetch",
        },
      },
    ],
    build: { recipe_digest: SHA("b"), toolchain_digest: SHA("c") },
    known_deviations: [],
    rollback: { previous_release_id: null },
    integrity: { level: "digest_only", signature: null },
  };
  const receipt = {
    schema_version: "promotion-receipt/v0",
    receipt_id: "r-1",
    subject: {
      bundle_digest: bundleDigest(bundle),
      selection_manifest_digest: SHA("d"),
      target: "production",
    },
  };
  const subject = {
    receipt_digest: jcs(receipt),
    receipt_semantic_digest: SHA("e"),
    bundle_digest: bundleDigest(bundle),
    selection_manifest_digest: SHA("d"),
    target: "production" as const,
  };

  const state: FakeState = {
    repository: REPO,
    now: T0,
    nowQueue: [],
    runs: {},
    artifacts: {},
    deployments: [],
    statuses: {},
    pagesList: "unsupported",
    deploymentsListFails: false,
    create: "created",
    nextDeploymentId: 777,
    posts: 0,
    postBodies: [],
    live: {},
  };
  const sb: Sandbox = {
    root,
    remote,
    ledger,
    authority,
    configPath,
    siteDir,
    archivePath,
    pagesArchivePath,
    tokenPath,
    evidenceArchivePath: evidenceArchiveOf({ root }, RUN_ID, 1),
    bundle,
    receipt,
    subject,
    state,
    common: {
      config: configPath,
      "ledger-repo": ledger,
      "authority-repo": authority,
      target: REPO,
      "github-api": "https://api.test",
    },
  };
  addSourceRun(sb, RUN_ID, 1);
  return sb;
}

let nextArtifactId = 5000;

export function evidenceArchiveOf(
  sb: Pick<Sandbox, "root">,
  runId: string,
  attempt: number,
): string {
  return path.join(sb.root, `release-evidence-out-${runId}-${attempt}.zip`);
}

/** The evidence artifact zip of one source run attempt: bundle.json (deflate), receipt.json
 * (stored) and a per-attempt marker file, so every attempt's archive has distinct bytes. */
export function evidenceZip(
  sb: Pick<Sandbox, "bundle" | "receipt">,
  runId: string,
  attempt: number,
  content: { bundle?: unknown; receipt?: unknown } = {},
): Buffer {
  return buildZip([
    { name: "bundle.json", data: JSON.stringify(content.bundle ?? sb.bundle), method: 8 },
    { name: "receipt.json", data: JSON.stringify(content.receipt ?? sb.receipt), method: 0 },
    { name: "logs/attempt.txt", data: `${runId}-${attempt}\n` },
  ]);
}

/** Writes the evidence archive of one source run attempt (defaults to the sandbox's sealed
 * bundle and receipt, or the given raw zip bytes) and makes the fake Actions API report its
 * sha256 as that artifact's digest. Returns the digest. */
export function writeEvidenceArchive(
  sb: Pick<Sandbox, "root" | "bundle" | "receipt" | "state">,
  runId: string,
  attempt: number,
  content: { bundle?: unknown; receipt?: unknown; zip?: Buffer } = {},
): string {
  const bytes = content.zip ?? evidenceZip(sb, runId, attempt, content);
  writeFileSync(evidenceArchiveOf(sb, runId, attempt), bytes);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const name = `release-evidence-out-${runId}-${attempt}`;
  for (const a of sb.state.artifacts[runId] ?? []) if (a.name === name) a.digest = digest;
  return digest;
}

/** A successful source run with its two named artifacts (and the evidence archive zip), plus
 * the executor attempt's pages artifact `github-pages-<EXECUTOR_RUN_ID>-1`. */
export function addSourceRun(sb: Sandbox, runId: string, attempt: number): void {
  const evidenceDigest = writeEvidenceArchive(sb, runId, attempt);
  sb.state.runs[`${runId}/${attempt}`] = {
    status: "completed",
    conclusion: "success",
    head_sha: HEAD_SHA,
  };
  const list = sb.state.artifacts[runId] ?? [];
  list.push(
    {
      id: nextArtifactId++,
      name: `site-dist-${runId}-${attempt}`,
      expired: false,
      digest: sha256Bytes("zip-bytes-of-site-dist"),
      workflow_run: { id: Number(runId) },
    },
    {
      id: nextArtifactId++,
      name: `release-evidence-out-${runId}-${attempt}`,
      expired: false,
      digest: evidenceDigest,
      workflow_run: { id: Number(runId) },
    },
  );
  sb.state.artifacts[runId] = list;
  if (!sb.state.artifacts[EXECUTOR_RUN_ID]) {
    sb.state.artifacts[EXECUTOR_RUN_ID] = [
      {
        id: 9001,
        name: `github-pages-${EXECUTOR_RUN_ID}-1`,
        expired: false,
        digest: sha256Bytes(readFileSync(sb.pagesArchivePath)),
        workflow_run: { id: Number(EXECUTOR_RUN_ID) },
      },
    ];
  }
}

export function deps(sb: Sandbox, extra: Partial<PromoteDeps> = {}): PromoteDeps {
  return {
    fetch: makeFetch(sb.state),
    validateBundle: () => [],
    checkReceipt: async () => [],
    sleep: async () => {},
    ...extra,
  };
}

export function authorizeFlags(
  sb: Sandbox,
  approvalId: string,
  runId = RUN_ID,
  attempt = 1,
): Flags {
  return {
    ...sb.common,
    "run-id": runId,
    "run-attempt": String(attempt),
    "executor-run-id": EXECUTOR_RUN_ID,
    "executor-run-attempt": "1",
    "approval-event-id": approvalId,
    "evidence-archive": evidenceArchiveOf(sb, runId, attempt),
    "site-url": "https://acme.github.io/site/",
    "site-dir": sb.siteDir,
    "archive-path": sb.archivePath,
  };
}

export function sendFlags(sb: Sandbox, runId = RUN_ID, attempt = 1): Flags {
  return {
    ...sb.common,
    "run-id": runId,
    "run-attempt": String(attempt),
    "pages-artifact-id": "9001",
    "pages-artifact-archive": sb.pagesArchivePath,
    "oidc-token-file": sb.tokenPath,
  };
}

/** Lines of the ledger on the remote ref (empty when the ref does not exist). */
export function remoteLedger(sb: Sandbox): Array<Record<string, unknown>> {
  try {
    const text = git(sb.remote, ["show", "refs/heads/promotion-ledger:promotion-events.jsonl"]);
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Writes an arbitrary commit onto the remote ledger ref (bypassing the CAS path). */
export function forceRemoteCommit(
  sb: Sandbox,
  files: Record<string, string>,
  parents: string[],
  scratchName = "scratch",
): string {
  const dir = path.join(sb.root, scratchName);
  try {
    git(sb.root, ["init", "-q", dir]);
    git(dir, ["remote", "add", "origin", sb.remote]);
  } catch {
    // already initialized
  }
  git(dir, ["fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  const entries = Object.entries(files)
    .map(
      ([name, content]) =>
        `100644 blob ${git(dir, ["hash-object", "-w", "--stdin"], content).trim()}\t${name}\n`,
    )
    .join("");
  const tree = git(dir, ["mktree"], entries).trim();
  const commit = git(dir, [
    "commit-tree",
    tree,
    ...parents.flatMap((p) => ["-p", p]),
    "-m",
    "raw",
  ]).trim();
  git(dir, ["push", "-q", "--force", "origin", `${commit}:refs/heads/promotion-ledger`]);
  return commit;
}

export function remoteHead(sb: Sandbox): string {
  return git(sb.remote, ["rev-parse", "refs/heads/promotion-ledger"]).trim();
}
