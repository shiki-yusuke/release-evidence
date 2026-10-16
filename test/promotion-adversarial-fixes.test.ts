// Regression tests for the adversarial review's three critical findings on the B1b promotion
// ledger. Each test fails on the code before the fix:
//   1. two sends building the byte-identical effect_send commit both POSTed (OID collision);
//   2. a deployment of another attempt (or a marker-less one) closed an unknown send;
//   3. a correctly named Pages artifact of a different dist was sent.
// Second round (each also fails before its fix):
//   R2-1. an entry named by both an 'L' and a pax path read differently from bsdtar / tarfile;
//   R2-2. a leading UTF-8 BOM was silently dropped from tar / zip entry names;
//   R2-3. the deployments listing stopped at 50 pages (incomplete -> finalize locked forever);
//   R2-4. an artifact id beyond 2^53 was POSTed as a rounded neighbour.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPromote } from "../src/promotion/commands.js";
import { buildEvent } from "../src/promotion/fold.js";
import { type GitRunner, execGit } from "../src/promotion/git-cas.js";
import { type FetchFn, GitHubProvider, isSafeArtifactId } from "../src/promotion/provider.js";
import { TarError, readTar } from "../src/promotion/tar.js";
import { EXIT } from "../src/promotion/types.js";
import {
  HEAD_SHA,
  REPO,
  RUN_ID,
  type Sandbox,
  T0,
  addSeconds,
  addSourceRun,
  authorizeFlags,
  deps,
  forceRemoteCommit,
  git,
  makeApproval,
  makeSandbox,
  newLedgerClone,
  pagesZipOf,
  remoteHead,
  remoteLedger,
  sendFlags,
  writeAuthority,
  writePagesArchive,
} from "./promotion-fixtures.js";
import { buildTar, paxRecords, tarOfDir } from "./tar-writer.js";
import { buildZip } from "./zip-writer.js";

vi.setConfig({ testTimeout: 60_000 });

const sandboxes: Sandbox[] = [];
function sandbox(): Sandbox {
  const sb = makeSandbox();
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  for (const sb of sandboxes.splice(0)) rmSync(sb.root, { recursive: true, force: true });
});

const kinds = (sb: Sandbox) => remoteLedger(sb).map((e) => e.kind);
const human = {
  "confirmed-full-listing": true,
  "observed-at": "2026-10-16T13:00:00Z",
  "actor-login": "octo-human",
};
const TARGET = { repository: REPO, environment: "github-pages" as const };

function setStatuses(sb: Sandbox, id: number, state: string, at = addSeconds(T0, 30)) {
  sb.state.statuses[String(id)] = [{ id: 1, state, created_at: at }];
}

function pushDeployment(sb: Sandbox, id: number, ref: string, createdAt = addSeconds(T0, 10)) {
  sb.state.deployments.push({
    id,
    sha: HEAD_SHA,
    ref,
    environment: "github-pages",
    created_at: createdAt,
    payload: {},
    description: null,
  });
}

/** Authorizes attempt `attempt` of RUN_ID (all approvals so far stay in the authority file). */
const approvals: Map<Sandbox, ReturnType<typeof makeApproval>[]> = new Map();
async function authorizeAttempt(
  sb: Sandbox,
  attempt: number,
  fetch?: FetchFn,
  expected: number = EXIT.ok,
) {
  const list = approvals.get(sb) ?? [];
  const approval = makeApproval({
    subject: sb.subject,
    occurred_at: `2026-10-16T0${list.length}:00:00Z`,
  });
  list.push(approval);
  approvals.set(sb, list);
  writeAuthority(sb, list);
  if (attempt > 1) addSourceRun(sb, RUN_ID, attempt);
  const r = await runPromote(
    "authorize",
    authorizeFlags(sb, approval.event_id, RUN_ID, attempt),
    deps(sb, fetch ? { fetch } : {}),
  );
  expect(r.exitCode, JSON.stringify(r.output)).toBe(expected);
  return r;
}

function contentDigestOf(sb: Sandbox): string {
  const auth = remoteLedger(sb).find((e) => e.kind === "authorized") as {
    resolved: { source_artifact: { content_manifest_digest: string } };
  };
  return auth.resolved.source_artifact.content_manifest_digest;
}

/** attempt 1: authorize -> send (deployment 777, marker <sha>:<run>:1) -> finalize(success). */
async function completedAttempt1(sb: Sandbox) {
  await authorizeAttempt(sb, 1);
  expect((await runPromote("send", sendFlags(sb, RUN_ID, 1), deps(sb))).exitCode).toBe(EXIT.ok);
  setStatuses(sb, 777, "success");
  const fin = await runPromote(
    "finalize",
    {
      ...sb.common,
      "run-id": RUN_ID,
      "run-attempt": "1",
      "page-url": "https://acme.github.io/site/",
      "expected-digest": contentDigestOf(sb),
    },
    deps(sb),
  );
  expect(fin.exitCode, JSON.stringify(fin.output)).toBe(EXIT.ok);
}

const reconcileFlags = (sb: Sandbox, attempt: number, candidate?: string) => ({
  ...sb.common,
  ...human,
  "run-id": RUN_ID,
  "run-attempt": String(attempt),
  ...(candidate !== undefined ? { "candidate-deployment-id": candidate } : {}),
});

// ---------------------------------------------------------------------------------------------

describe("critical 1: identical sends from one head -> one POST", () => {
  // Same author/committer dates for every commit: with identical provider time and inputs the
  // only thing left to tell two processes' commits apart is the CAS nonce.
  const fixedDates: GitRunner = (args, opts) =>
    execGit(args, {
      ...opts,
      env: {
        ...opts.env,
        GIT_AUTHOR_DATE: "2026-10-16T12:00:00Z",
        GIT_COMMITTER_DATE: "2026-10-16T12:00:00Z",
      },
    });

  it("two sends racing from the same head: one POST, one effect_send, loser exit 3", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    const cloneB = newLedgerClone(sb, "ledger-b");
    let b: Awaited<ReturnType<typeof runPromote>> | undefined;
    const a = await runPromote(
      "send",
      sendFlags(sb),
      deps(sb, {
        git: fixedDates,
        hooks: {
          // A has built its effect_send commit on head H; B now runs to completion from H.
          beforePush: async () => {
            if (b) return;
            b = await runPromote(
              "send",
              { ...sendFlags(sb), "ledger-repo": cloneB },
              deps(sb, { git: fixedDates }),
            );
          },
        },
      }),
    );
    expect(b?.exitCode, JSON.stringify(b?.output)).toBe(EXIT.ok);
    expect(a.exitCode, JSON.stringify(a.output)).toBe(EXIT.precondition);
    expect(sb.state.posts).toBe(1);
    expect(kinds(sb).filter((k) => k === "effect_send")).toHaveLength(1);
    expect(git(sb.remote, ["log", "-1", "--format=%B", "refs/heads/promotion-ledger"])).toMatch(
      /^Promotion-Cas-Nonce: [0-9a-f]{32}$/m,
    );
  });

  it("send does not POST when the effect_send on the ledger is not its own", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    const r = await runPromote(
      "send",
      sendFlags(sb),
      deps(sb, {
        hooks: {
          // Someone replaces the ledger: same facts, but an effect_send line of another process.
          afterEffectSend: async () => {
            const lines = remoteLedger(sb);
            const last = lines.at(-1) as Record<string, unknown>;
            last.event_id = `pe-${"f".repeat(40)}`;
            const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
            forceRemoteCommit(sb, { "promotion-events.jsonl": text }, []);
          },
        },
      }),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/not this process's/);
    expect(sb.state.posts).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("critical 2: only an exact marker attributes a deployment", () => {
  it("attempt 1's completed deployment as attempt 2's candidate -> exit 6, nothing written", async () => {
    const sb = sandbox();
    await completedAttempt1(sb);
    await authorizeAttempt(sb, 2);
    sb.state.create = "timeout";
    const sent = await runPromote("send", sendFlags(sb, RUN_ID, 2), deps(sb));
    expect(sent.exitCode, JSON.stringify(sent.output)).toBe(EXIT.nonTerminal);
    sb.state.now = addSeconds(T0, 60);
    const head = remoteHead(sb);
    const r = await runPromote("reconcile", reconcileFlags(sb, 2, "777"), deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.nonTerminal);
    expect(r.output.status).toBe("candidate_mismatch");
    expect(remoteHead(sb)).toBe(head);
    const lock = await runPromote("lock-status", sb.common, deps(sb));
    expect(lock.output.locked).toBe(true);
  });

  it("a marker-less deployment (env/sha/time fit) as candidate -> exit 6, nothing written", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    sb.state.create = "timeout";
    await runPromote("send", sendFlags(sb), deps(sb));
    pushDeployment(sb, 900, "main");
    setStatuses(sb, 900, "success");
    const head = remoteHead(sb);
    const r = await runPromote("reconcile", reconcileFlags(sb, 1, "900"), deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.nonTerminal);
    expect(r.output.status).toBe("candidate_without_marker");
    expect(remoteHead(sb)).toBe(head);
  });

  it("a candidate with exactly this promotion's marker -> terminal(via=reconcile)", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    sb.state.create = "timeout";
    await runPromote("send", sendFlags(sb), deps(sb));
    pushDeployment(sb, 901, `${HEAD_SHA}:${RUN_ID}:1`);
    setStatuses(sb, 901, "success");
    const r = await runPromote("reconcile", reconcileFlags(sb, 1, "901"), deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      kind: "terminal",
      via: "reconcile",
      deployment_id: "901",
      outcome: "completed",
    });
    expect((await runPromote("lock-status", sb.common, deps(sb))).output.locked).toBe(false);
  });

  it("fold: a deployment already recorded for another promotion cannot close this one", async () => {
    const sb = sandbox();
    await completedAttempt1(sb);
    await authorizeAttempt(sb, 2);
    sb.state.create = "timeout";
    await runPromote("send", sendFlags(sb, RUN_ID, 2), deps(sb));
    const forged = buildEvent(
      {
        kind: "terminal",
        promotion_id: { run_id: RUN_ID, run_attempt: 2 },
        deployment_id: "777",
        via: "reconcile",
        resolution: "operation_completed",
        operation_completed: { state: "success", status_id: "1", observed_at: T0 },
        desired_state_observed: null,
        outcome: "completed",
        reconcile: {
          human_confirmation: {
            confirmed_full_listing: true,
            observed_at: human["observed-at"],
            actor_login: human["actor-login"],
          },
          listing: null,
          criteria: { environment: "github-pages", sha: HEAD_SHA, created_at_not_before: T0 },
        },
      },
      TARGET,
      addSeconds(T0, 60),
    );
    const text = `${[...remoteLedger(sb), forged].map((l) => JSON.stringify(l)).join("\n")}\n`;
    forceRemoteCommit(sb, { "promotion-events.jsonl": text }, [remoteHead(sb)]);
    const lock = await runPromote("lock-status", sb.common, deps(sb));
    expect(lock.output).toMatchObject({ locked: true, reasons: ["ledger_invalid"] });
    expect(JSON.stringify(lock.output.problems)).toMatch(/deployment_attributed_elsewhere: 777/);
    const ingest = await runPromote("ingest", sb.common, deps(sb));
    expect(ingest.exitCode).toBe(EXIT.ledgerInvalid);
  });

  it("late-effect scan: an unattributed deployment after a COMPLETED promotion locks the target", async () => {
    const sb = sandbox();
    await completedAttempt1(sb);
    pushDeployment(sb, 950, "main", addSeconds(T0, 120));
    setStatuses(sb, 950, "success");
    const list = approvals.get(sb) ?? [];
    const next = makeApproval({ subject: sb.subject, occurred_at: "2026-10-16T05:00:00Z" });
    writeAuthority(sb, [...list, next]);
    addSourceRun(sb, RUN_ID, 2);
    const blocked = await runPromote(
      "authorize",
      authorizeFlags(sb, next.event_id, RUN_ID, 2),
      deps(sb),
    );
    expect(blocked.exitCode, JSON.stringify(blocked.output)).toBe(EXIT.precondition);
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      kind: "late_effect_detected",
      deployment_id: "950",
      matched_promotion_id: null,
    });
    const lock = await runPromote("lock-status", sb.common, deps(sb));
    expect(lock.output.locked).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("critical 3: send checks what the Pages artifact actually serves", () => {
  it("dist B under the right name and API digest -> exit 3, no POST, ledger unchanged", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    const distB = path.join(sb.root, "dist-b");
    mkdirSync(distB);
    writeFileSync(path.join(distB, "index.html"), "<h1>not what was approved</h1>\n");
    writePagesArchive(sb, pagesZipOf(distB));
    const head = remoteHead(sb);
    const r = await runPromote("send", sendFlags(sb), deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/content .* != authorized content_manifest_digest/);
    expect(sb.state.posts).toBe(0);
    expect(remoteHead(sb)).toBe(head);
  });

  it("the approved site A is sent and effect_send records its content digest", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    const r = await runPromote("send", sendFlags(sb), deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(sb.state.posts).toBe(1);
    const send = remoteLedger(sb).find((e) => e.kind === "effect_send") as {
      pages_artifact: { content_manifest_digest: string };
    };
    expect(send.pages_artifact.content_manifest_digest).toBe(contentDigestOf(sb));
  });

  it("an artifact.tar with a symlink is refused by send (exit 3, no POST)", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    const tar = buildTar([
      { name: "./index.html", data: "<h1>hello</h1>\n" },
      { name: "./evil", type: "2", linkname: "/etc/passwd" },
    ]);
    writePagesArchive(sb, buildZip([{ name: "artifact.tar", data: tar }]));
    const r = await runPromote("send", sendFlags(sb), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/unsupported entry type "2"/);
    expect(sb.state.posts).toBe(0);
  });

  it("an archive without artifact.tar is refused", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    writePagesArchive(sb, buildZip([{ name: "index.html", data: "<h1>hello</h1>\n" }]));
    const r = await runPromote("send", sendFlags(sb), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/artifact\.tar/);
    expect(sb.state.posts).toBe(0);
  });
});

describe("tar reader", () => {
  const refuses = (tar: Buffer, re: RegExp) => {
    expect(() => readTar(tar)).toThrow(TarError);
    expect(() => readTar(tar)).toThrow(re);
  };

  it("reads ustar files and directories, dropping the ./ root", () => {
    const entries = readTar(
      buildTar([
        { name: "./", type: "5" },
        { name: "./a/", type: "5" },
        { name: "./a/b.txt", data: "B" },
        { name: "c.txt", data: "C", gnu: true },
        { name: "d.txt", prefix: "x/y", data: "D" },
      ]),
    );
    expect(entries.map((e) => [e.path, e.type, e.data.toString()])).toEqual([
      ["a", "directory", ""],
      ["a/b.txt", "file", "B"],
      ["c.txt", "file", "C"],
      ["x/y/d.txt", "file", "D"],
    ]);
  });

  it("pax path and GNU long names (> 100 bytes) are used as the entry path", () => {
    const long = `${"d".repeat(120)}/${"f".repeat(90)}.html`;
    const entries = readTar(
      buildTar([
        { name: "./short-placeholder", pax: { path: `./${long}`, mtime: "1.5" }, data: "P" },
        { name: `./gnu-${long}`, longName: true, data: "L" },
      ]),
    );
    expect(entries.map((e) => e.path)).toEqual([long, `gnu-${long}`]);
  });

  it("refuses symlinks, hard links and devices", () => {
    refuses(buildTar([{ name: "l", type: "2", linkname: "x" }]), /unsupported entry type "2"/);
    refuses(buildTar([{ name: "h", type: "1", linkname: "x" }]), /unsupported entry type "1"/);
    refuses(buildTar([{ name: "c", type: "3" }]), /unsupported entry type "3"/);
  });

  it('refuses "..", absolute paths, backslashes and duplicates', () => {
    refuses(buildTar([{ name: "./a/../../etc/passwd", data: "x" }]), /"\.\."/);
    refuses(buildTar([{ name: "/etc/passwd", data: "x" }]), /absolute/);
    refuses(buildTar([{ name: "a\\b", data: "x" }]), /backslash/);
    refuses(buildTar([{ name: "x", pax: { path: "../x" }, data: "x" }]), /"\.\."/);
    refuses(
      buildTar([
        { name: "./a.html", data: "1" },
        { name: "a.html", data: "2" },
      ]),
      /duplicate/,
    );
    refuses(
      buildTar([
        { name: "a", data: "1" },
        { name: "a/b", data: "2" },
      ]),
      /file used as a directory/,
    );
  });

  it("refuses a checksum mismatch, a missing end of archive and trailing data", () => {
    refuses(buildTar([{ name: "a", data: "x", checksumDelta: 1 }]), /checksum mismatch/);
    refuses(buildTar([{ name: "a", data: "x" }], { endBlocks: 1 }), /end of archive/);
    refuses(buildTar([{ name: "a", data: "x" }], { endBlocks: 0 }), /end blocks/);
    refuses(
      buildTar([{ name: "a", data: "x" }], { trailer: Buffer.alloc(512, 1) }),
      /after the end of archive/,
    );
  });

  it("refuses data that overruns the archive and unsupported pax keys", () => {
    const tar = buildTar([{ name: "a", data: "x".repeat(600) }]);
    refuses(tar.subarray(0, 1024), /overruns|end blocks/);
    refuses(buildTar([{ name: "a", pax: { size: "1" }, data: "x" }]), /unsupported pax key/);
  });
});

// ---------------------------------------------------------------------------------------------
// Second round

/** Rewrites the body text of responses whose path matches `path` (e.g. a JSON number). */
function rewriting(inner: FetchFn, path: RegExp, from: string | RegExp, to: string): FetchFn {
  return async (url, init) => {
    const res = await inner(url, init);
    if (!path.test(new URL(url).pathname)) return res;
    const text = (await res.text()).replace(from, to);
    return new Response(text, { status: res.status, headers: res.headers });
  };
}

const L = (name: string) => ({ name: "././@LongLink", type: "L", data: `${name}\0`, gnu: true });
const X = (records: Record<string, string>) => ({
  name: "PaxHeader",
  type: "x",
  data: paxRecords(records),
});

describe("R2-1: every tar entry has exactly one name source", () => {
  const refuses = (tar: Buffer, re: RegExp) => {
    expect(() => readTar(tar)).toThrow(TarError);
    expect(() => readTar(tar)).toThrow(re);
  };
  // bsdtar / tarfile: approved-copy.html=A, index.html=B; the old reader: index.html=A,
  // release-manifest.json=B.
  const confused = () =>
    buildTar([
      L("approved-copy.html"),
      X({ path: "index.html" }),
      { name: "placeholder-a", data: "<h1>A</h1>\n" },
      L("index.html"),
      X({ path: "release-manifest.json" }),
      { name: "placeholder-b", data: "<h1>B</h1>\n" },
    ]);

  it("send: an 'L' + pax path tar -> exit 3, no POST, ledger unchanged", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    writePagesArchive(sb, buildZip([{ name: "artifact.tar", data: confused() }]));
    const head = remoteHead(sb);
    const r = await runPromote("send", sendFlags(sb), deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/both a GNU long name and a pax path/);
    expect(sb.state.posts).toBe(0);
    expect(remoteHead(sb)).toBe(head);
  });

  it("refuses 'L' + pax path in either order", () => {
    refuses(confused(), /both a GNU long name and a pax path/);
    refuses(
      buildTar([X({ path: "a.html" }), L("b.html"), { name: "p", data: "x" }]),
      /both a GNU long name and a pax path/,
    );
  });

  it("refuses 'g', 'K', two 'L' / 'x' for one entry, and a meta header without an entry", () => {
    refuses(buildTar([{ name: "g", type: "g", data: paxRecords({ path: "a" }) }]), /global/);
    refuses(
      buildTar([
        { name: "k", type: "K", data: "x\0" },
        { name: "a", data: "x" },
      ]),
      /long link/,
    );
    refuses(buildTar([L("a"), X({ mtime: "1" }), L("b"), { name: "p", data: "x" }]), /two 'L'/);
    refuses(buildTar([X({ mtime: "1" }), L("a"), X({ mtime: "2" }), { name: "p" }]), /two 'x'/);
    refuses(buildTar([L("a"), { name: "s", type: "2", linkname: "x" }]), /after an 'L' \/ 'x'/);
    refuses(buildTar([L("a")]), /not followed by an entry/);
    refuses(buildTar([X({ path: "a", mtime: "1", "path ": "b" }), { name: "p" }]), /pax key/);
  });

  it("an 'L' alone, an 'x' alone, and 'L' + path-less 'x' still name the entry", () => {
    const entries = readTar(
      buildTar([
        L("only-long.html"),
        { name: "p1", data: "1" },
        X({ path: "only-pax.html" }),
        { name: "p2", data: "2" },
        L("long-with-mtime.html"),
        X({ mtime: "1.5" }),
        { name: "p3", data: "3" },
      ]),
    );
    expect(entries.map((e) => e.path)).toEqual([
      "only-long.html",
      "only-pax.html",
      "long-with-mtime.html",
    ]);
  });
});

describe("R2-2: entry names are strict UTF-8 and keep a BOM (then refused)", () => {
  it("tar: a BOM-prefixed name (header, 'L' or pax) and invalid UTF-8 are refused", () => {
    expect(() => readTar(buildTar([{ name: "﻿index.html", data: "x" }]))).toThrow(/U\+FEFF/);
    expect(() => readTar(buildTar([L("﻿index.html"), { name: "p", data: "x" }]))).toThrow(/U\+FEFF/);
    expect(() => readTar(buildTar([X({ path: "﻿index.html" }), { name: "p", data: "x" }]))).toThrow(
      /U\+FEFF/,
    );
    const raw = Buffer.from([0x69, 0xff, 0x2e, 0x68]);
    expect(() => readTar(buildTar([{ name: "", nameBytes: raw, data: "x" }]))).toThrow(
      /not valid UTF-8/,
    );
  });

  it("send: the approved site under a BOM-prefixed zip name artifact.tar -> exit 3, no POST", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    writePagesArchive(sb, buildZip([{ name: "﻿artifact.tar", data: tarOfDir(sb.siteDir) }]));
    const head = remoteHead(sb);
    const r = await runPromote("send", sendFlags(sb), deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/U\+FEFF/);
    expect(sb.state.posts).toBe(0);
    expect(remoteHead(sb)).toBe(head);
  });
});

describe("R2-3: the deployments listing walks to `since` or the last page", () => {
  const SINCE = "2026-10-16T12:00:00Z";
  const at = (s: number) => new Date(Date.parse(SINCE) + s * 1000).toISOString();
  const dep = (id: number, createdAt: string) => ({
    id,
    sha: "b".repeat(40),
    ref: "main",
    environment: "github-pages",
    created_at: createdAt,
    payload: {},
    description: null,
  });
  /** Serves `pages` (1-based ?page=); Link rel="next" while `next(page)`. */
  function served(pages: (page: number) => unknown[], next: (page: number) => boolean) {
    const calls: number[] = [];
    const fetch: FetchFn = async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      calls.push(page);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (next(page)) {
        headers.link = `<https://api.test/repositories/1/deployments?page=${page + 1}>; rel="next", <https://api.test/repositories/1/deployments?page=9999>; rel="last"`;
      }
      return new Response(JSON.stringify(pages(page)), { status: 200, headers });
    };
    const provider = new GitHubProvider({ fetch, apiBase: "https://api.test", repository: REPO });
    return { provider, calls };
  }
  const list = (p: GitHubProvider) =>
    p.listDeployments({ environment: "github-pages", since: SINCE });

  it("60 full pages, one deployment since `since`: complete, that one, page 1 only", async () => {
    // newest first: index 0 is after since, everything else before it.
    const { provider, calls } = served(
      (page) =>
        Array.from({ length: 100 }, (_, k) => {
          const i = (page - 1) * 100 + k;
          return dep(10_000 + i, at(i === 0 ? 60 : -i));
        }),
      (page) => page < 60,
    );
    const r = await list(provider);
    expect(r.complete, r.reason).toBe(true);
    expect(r.items.map((d) => d.id)).toEqual(["10000"]);
    expect(calls).toEqual([1]);
  });

  it("120 pages all since `since`: complete with every item (no 50-page cap)", async () => {
    const { provider, calls } = served(
      (page) =>
        Array.from({ length: 100 }, (_, k) => {
          const i = (page - 1) * 100 + k;
          return dep(20_000 + i, at(100_000 - i));
        }),
      (page) => page < 120,
    );
    const r = await list(provider);
    expect(r.complete, r.reason).toBe(true);
    expect(r.items).toHaveLength(12_000);
    expect(r.pages_fetched).toBe(120);
    expect(calls).toHaveLength(120);
  });

  it("a full page without Link rel=next ends the listing", async () => {
    const { provider, calls } = served(
      () => Array.from({ length: 100 }, (_, k) => dep(30_000 + k, at(1000 - k))),
      () => false,
    );
    const r = await list(provider);
    expect(r.complete).toBe(true);
    expect(r.items).toHaveLength(100);
    expect(calls).toEqual([1]);
  });

  it("a page out of created_at descending order -> incomplete", async () => {
    const { provider } = served(
      (page) => (page === 1 ? [dep(1, at(100)), dep(2, at(90))] : [dep(3, at(95))]),
      (page) => page < 2,
    );
    const r = await list(provider);
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/descending/);
  });

  it("Link rel=next forever -> incomplete at the 1,000-page safety valve", async () => {
    const { provider, calls } = served(
      (page) => [dep(page, at(10_000 - page))],
      () => true,
    );
    const r = await list(provider);
    expect(r.complete).toBe(false);
    expect(r.reason).toMatch(/page limit/);
    expect(calls).toHaveLength(1000);
  });

  it("finalize with 60 pages of old deployment history completes (no permanent lock)", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    expect((await runPromote("send", sendFlags(sb), deps(sb))).exitCode).toBe(EXIT.ok);
    setStatuses(sb, 777, "success");
    const inner = deps(sb).fetch;
    const withHistory: FetchFn = async (url, init) => {
      const u = new URL(url);
      if (u.pathname !== `/repos/${REPO}/deployments` || (init?.method ?? "GET") !== "GET") {
        return inner(url, init);
      }
      const page = Number(u.searchParams.get("page") ?? "1");
      const first = new URL(url);
      first.searchParams.set("page", "1");
      const real = page === 1 ? ((await (await inner(first.toString(), init)).json()) as []) : [];
      const old = Array.from({ length: 100 - real.length }, (_, k) => {
        const i = (page - 1) * 100 + k;
        return dep(
          500_000 + i,
          new Date(Date.parse("2020-01-01T00:00:00Z") - i * 1000).toISOString(),
        );
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (page < 60) headers.link = `<${url}&next>; rel="next"`;
      return new Response(JSON.stringify([...real, ...old]), { status: 200, headers });
    };
    const fin = await runPromote(
      "finalize",
      {
        ...sb.common,
        "run-id": RUN_ID,
        "run-attempt": "1",
        "page-url": "https://acme.github.io/site/",
        "expected-digest": contentDigestOf(sb),
      },
      deps(sb, { fetch: withHistory }),
    );
    expect(fin.exitCode, JSON.stringify(fin.output)).toBe(EXIT.ok);
    expect(kinds(sb)).toContain("terminal");
    expect(kinds(sb)).not.toContain("late_effect_detected");
  });
});

describe("R2-4: artifact ids beyond Number.MAX_SAFE_INTEGER are refused", () => {
  const UNSAFE = "9007199254740993"; // Number() would round it to ...992
  const SAFE = "9007199254740991";
  const pagesIdAs = (sb: Sandbox, id: string) =>
    rewriting(deps(sb).fetch, /\/artifacts$/, /"id":9001,/g, `"id":${id},`);

  it("isSafeArtifactId", () => {
    expect(isSafeArtifactId(UNSAFE)).toBe(false);
    expect(isSafeArtifactId(SAFE)).toBe(true);
    expect(isSafeArtifactId("0")).toBe(false);
  });

  it("send with pages artifact id 9007199254740993 -> exit 3, no POST, ledger unchanged", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    const head = remoteHead(sb);
    const r = await runPromote(
      "send",
      { ...sendFlags(sb), "pages-artifact-id": UNSAFE },
      deps(sb, { fetch: pagesIdAs(sb, UNSAFE) }),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/9007199254740993/);
    expect(sb.state.posts).toBe(0);
    expect(remoteHead(sb)).toBe(head);
  });

  it("send with pages artifact id 9007199254740991 POSTs exactly that id", async () => {
    const sb = sandbox();
    await authorizeAttempt(sb, 1);
    const r = await runPromote(
      "send",
      { ...sendFlags(sb), "pages-artifact-id": SAFE },
      deps(sb, { fetch: pagesIdAs(sb, SAFE) }),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(sb.state.posts).toBe(1);
    expect((sb.state.postBodies[0] as { artifact_id: number }).artifact_id).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("authorize with an unsafe source artifact id -> exit 3, nothing written", async () => {
    const sb = sandbox();
    const site = (sb.state.artifacts[RUN_ID] ?? []).find((a) => a.name.startsWith("site-dist-"));
    expect(site).toBeDefined();
    const fetch = rewriting(
      deps(sb).fetch,
      /\/artifacts$/,
      `"id":${site?.id},"name":"site-dist-`,
      `"id":${UNSAFE},"name":"site-dist-`,
    );
    const r = await authorizeAttempt(sb, 1, fetch, EXIT.precondition);
    expect(String(r.output.error)).toMatch(/9007199254740993/);
    expect(git(sb.remote, ["for-each-ref", "refs/heads/promotion-ledger"]).trim()).toBe("");
  });
});
