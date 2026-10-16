// Negative tests for the B1b review fixes, each of which fails against the pre-fix code:
// (1) receipt/bundle attribution to the source attempt's evidence artifact, (2) push failure
// classification, (3) provider facts re-read inside every CAS attempt, (4) BigInt status
// tie-break, (5) the Pages artifact pinned to the executor attempt by name.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../src/promotion/artifact.js";
import {
  type Flags,
  PROMOTE_ALLOWED_FLAGS,
  PROMOTE_USAGE,
  runPromote,
} from "../src/promotion/commands.js";
import { type GitRunner, execGit } from "../src/promotion/git-cas.js";
import { GitHubProvider, quoteUnsafeIntegers } from "../src/promotion/provider.js";
import { EXIT } from "../src/promotion/types.js";
import {
  EXECUTOR_RUN_ID,
  HEAD_SHA,
  RUN_ID,
  type Sandbox,
  T0,
  addSeconds,
  addSourceRun,
  authorizeFlags,
  deps,
  evidenceArchiveOf,
  jcs,
  makeApproval,
  makeSandbox,
  remoteHead,
  remoteLedger,
  sendFlags,
  sha256Bytes,
  writeAuthority,
  writeEvidenceArchive,
} from "./promotion-fixtures.js";

vi.setConfig({ testTimeout: 60_000 });

const sandboxes: Sandbox[] = [];
function sandbox(o?: Parameters<typeof makeSandbox>[0]): Sandbox {
  const sb = makeSandbox(o);
  sandboxes.push(sb);
  return sb;
}
afterEach(() => {
  for (const sb of sandboxes.splice(0)) rmSync(sb.root, { recursive: true, force: true });
});

const withoutArchive = (flags: Flags): Flags =>
  Object.fromEntries(Object.entries(flags).filter(([k]) => k !== "evidence-archive"));
type AuthLine = {
  resolved: {
    receipt_promotion_id: unknown;
    derived_promotion_id: unknown;
    source_artifact: { evidence_artifact: Record<string, unknown> };
  };
};

const kinds = (sb: Sandbox) => remoteLedger(sb).map((e) => e.kind);

function grant(sb: Sandbox, subject = sb.subject) {
  const approval = makeApproval({ subject });
  writeAuthority(sb, [approval]);
  return approval;
}

async function authorized(sb: Sandbox) {
  const approval = grant(sb);
  const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
  expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
  return approval;
}

function setStatuses(sb: Sandbox, id: number, states: Array<[number | string, string, string]>) {
  sb.state.statuses[String(id)] = states.map(([sid, state, at]) => ({
    id: sid as number,
    state,
    created_at: at,
  }));
}

type PushStep =
  | "real"
  | "landed-but-nonzero"
  | "lease-rejected"
  | "remote-ref-race"
  | "remote-rejected-hook"
  | "network-error";

/** Real git, except `push`, which follows `plan` (then "real"). "network-error" also makes the
 * following re-fetch fail when `fetchFailsAfter` is set. */
function scriptedGit(plan: PushStep[], opts: { fetchFailsAfter?: boolean } = {}) {
  let pushes = 0;
  let broken = false;
  const git: GitRunner = async (args, o) => {
    if (broken && args[0] === "ls-remote") {
      throw new Error("git ls-remote failed (exit 128): fatal: Could not resolve host: github.com");
    }
    if (args[0] !== "push") return execGit(args, o);
    const step = plan[pushes++] ?? "real";
    if (step === "real") return execGit(args, o);
    if (step === "landed-but-nonzero") {
      await execGit(args, o);
      throw new Error("git push failed (exit 1): ");
    }
    if (step === "lease-rejected") {
      throw new Error(
        "git push failed (exit 1): error: failed to push some refs to 'origin' | stdout: To origin\n!\tX:refs/heads/promotion-ledger\t[rejected] (stale info)\nDone",
      );
    }
    if (step === "remote-ref-race") {
      throw new Error(
        "git push failed (exit 1): remote: error: cannot lock ref 'refs/heads/promotion-ledger': reference already exists | stdout: !\tX:refs/heads/promotion-ledger\t[remote rejected] (failed to update ref)",
      );
    }
    if (step === "remote-rejected-hook") {
      throw new Error(
        "git push failed (exit 1): remote: error: GH013: Repository rule violations found | stdout: !\tX:refs/heads/promotion-ledger\t[remote rejected] (push declined due to repository rule violations)",
      );
    }
    if (opts.fetchFailsAfter) broken = true;
    throw new Error(
      "git push failed (exit 128): fatal: unable to access 'https://github.com/acme/ledger.git/': Could not resolve host: github.com",
    );
  };
  return { git, pushes: () => pushes };
}

const finalizeFlags = (sb: Sandbox, extra: Record<string, string> = {}) => ({
  ...sb.common,
  "run-id": RUN_ID,
  "run-attempt": "1",
  "page-url": "https://acme.github.io/site/",
  "expected-digest": (sb.bundle.artifacts as Array<{ digest: string }>)[0]?.digest as string,
  ...extra,
});
const human = {
  "confirmed-full-listing": true,
  "observed-at": "2026-10-16T14:00:00Z",
  "actor-login": "octocat",
};

// ---------------------------------------------------------------------------------------------

describe("fix 1: receipt/bundle come from this attempt's evidence artifact", () => {
  it("USAGE / allowlist: --evidence-archive (required) replaces --evidence-dir / --bundle / --receipt", () => {
    expect(PROMOTE_ALLOWED_FLAGS.authorize).toContain("evidence-archive");
    for (const gone of ["evidence-dir", "bundle", "receipt"]) {
      expect(PROMOTE_ALLOWED_FLAGS.authorize).not.toContain(gone);
    }
    expect(PROMOTE_USAGE.authorize).toMatch(/ --evidence-archive </);
    expect(PROMOTE_USAGE.authorize).not.toMatch(
      /\[--evidence-archive|--evidence-dir|--bundle|--receipt/,
    );
  });

  it("without --evidence-archive authorize is a usage error and writes nothing", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const r = await runPromote(
      "authorize",
      withoutArchive(authorizeFlags(sb, approval.event_id)),
      deps(sb),
    );
    expect(r.exitCode).toBe(EXIT.usage);
    expect(String(r.output.error)).toMatch(/--evidence-archive/);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("evidence archive of another attempt is refused (bytes != this attempt's artifact digest)", async () => {
    const sb = sandbox();
    addSourceRun(sb, RUN_ID, 2);
    const approval = grant(sb);
    const flags = authorizeFlags(sb, approval.event_id, RUN_ID, 2);
    flags["evidence-archive"] = evidenceArchiveOf(sb, RUN_ID, 1);
    const r = await runPromote("authorize", flags, deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/archive .* hashes to .* provider reports/);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("no artifact of that exact name in the run (only the other attempt's) is refused", async () => {
    const sb = sandbox();
    addSourceRun(sb, RUN_ID, 2);
    const list = sb.state.artifacts[RUN_ID] ?? [];
    sb.state.artifacts[RUN_ID] = list.filter((a) => a.name !== `release-evidence-out-${RUN_ID}-2`);
    const approval = grant(sb);
    const flags = authorizeFlags(sb, approval.event_id, RUN_ID, 2);
    const r = await runPromote("authorize", flags, deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/release-evidence-out-1001-2/);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("bundle.json whose JCS digest != approval subject.bundle_digest is refused", async () => {
    const sb = sandbox();
    // a self-consistent evidence archive (receipt points at its bundle) for a bundle the approval
    // did not approve; the approval's receipt_digest is aligned so only the bundle differs
    const bundle = { ...sb.bundle, release_id: "site@9.9.9" };
    const { bundleDigest } = await import("../src/core/bundle.js");
    const receipt = {
      ...sb.receipt,
      subject: { ...(sb.receipt.subject as object), bundle_digest: bundleDigest(bundle as never) },
    };
    writeEvidenceArchive(sb, RUN_ID, 1, { bundle, receipt });
    const approval = grant(sb, { ...sb.subject, receipt_digest: jcs(receipt) });
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/bundle_digest/);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("receipt.promotion_id (when present) must equal the promotion exactly", async () => {
    for (const [pid, ok] of [
      [{ run_id: RUN_ID, run_attempt: 2 }, false],
      [{ run_id: RUN_ID, run_attempt: "1" }, false],
      [{ run_id: "1002", run_attempt: 1 }, false],
      [{ run_id: RUN_ID, run_attempt: 1, extra: true }, false],
      [{ run_id: RUN_ID, run_attempt: 1 }, true],
    ] as const) {
      const sb = sandbox();
      const receipt = { ...sb.receipt, promotion_id: pid };
      writeEvidenceArchive(sb, RUN_ID, 1, { receipt });
      const approval = grant(sb, { ...sb.subject, receipt_digest: jcs(receipt) });
      const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
      if (ok) {
        expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
        const auth = remoteLedger(sb)[1] as AuthLine;
        expect(auth.resolved.receipt_promotion_id).toEqual({ run_id: RUN_ID, run_attempt: 1 });
        expect(auth.resolved.derived_promotion_id).toBeNull();
      } else {
        expect(r.exitCode, JSON.stringify(pid)).toBe(EXIT.precondition);
        expect(String(r.output.error)).toMatch(/promotion_id/);
        expect(remoteLedger(sb)).toEqual([]);
      }
    }
  });

  it("evidence archive bytes != Actions artifact.digest is refused", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    writeFileSync(sb.evidenceArchivePath, "other-bytes");
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/archive/);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("records evidence_artifact with the verified archive digest; no receipt promotion_id -> derived", async () => {
    const sb = sandbox();
    await authorized(sb);
    const auth = remoteLedger(sb)[1] as AuthLine;
    expect(auth.resolved.source_artifact.evidence_artifact).toMatchObject({
      name: `release-evidence-out-${RUN_ID}-1`,
      archive_digest: sha256File(sb.evidenceArchivePath),
    });
    expect(auth.resolved.receipt_promotion_id).toBeNull();
    expect(auth.resolved.derived_promotion_id).toEqual({
      run_id: RUN_ID,
      run_attempt: 1,
      derived_from: "artifact_name",
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("fix 2: push failure classification", () => {
  it("push landed but git exited non-zero with empty stderr -> landed, read-back, exit 0", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const g = scriptedGit(["landed-but-nonzero"]);
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, approval.event_id),
      deps(sb, { git: g.git }),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(r.output.attempts).toBe(1);
    expect(g.pushes()).toBe(1);
    expect(kinds(sb)).toEqual(["authority_ingested", "authorized"]);
  });

  it("lease rejection (stale info) is retried and rebuilt", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const g = scriptedGit(["lease-rejected"]);
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, approval.event_id),
      deps(sb, { git: g.git }),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(r.output.attempts).toBe(2);
    expect(g.pushes()).toBe(2);
  });

  it("the remote's ref-transaction compare failing (concurrent push) is a lease rejection", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const g = scriptedGit(["remote-ref-race"]);
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, approval.event_id),
      deps(sb, { git: g.git }),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(g.pushes()).toBe(2);
  });

  it("[remote rejected] by a ruleset is not a lease rejection -> exit 5, no retry", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const g = scriptedGit(["remote-rejected-hook"]);
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, approval.event_id),
      deps(sb, { git: g.git }),
    );
    expect(r.exitCode).toBe(EXIT.readBackMismatch);
    expect(g.pushes()).toBe(1);
  });

  it("lease rejections every time -> exit 4 after a final fetch shows nothing of ours", async () => {
    const sb = sandbox({ max_cas_retries: 2 });
    const approval = grant(sb);
    const g = scriptedGit(["lease-rejected", "lease-rejected"]);
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, approval.event_id),
      deps(sb, { git: g.git }),
    );
    expect(r.exitCode).toBe(EXIT.casExhausted);
    expect(g.pushes()).toBe(2);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("network error (no lease marker, not landed) -> exit 5, no retry", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const g = scriptedGit(["network-error"]);
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, approval.event_id),
      deps(sb, { git: g.git }),
    );
    expect(r.exitCode).toBe(EXIT.readBackMismatch);
    expect(String(r.output.error)).toMatch(/uncertain/);
    expect(g.pushes()).toBe(1);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("push failed and the re-fetch fails too -> exit 5, no retry", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const g = scriptedGit(["network-error"], { fetchFailsAfter: true });
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, approval.event_id),
      deps(sb, { git: g.git }),
    );
    expect(r.exitCode).toBe(EXIT.readBackMismatch);
    expect(g.pushes()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("fix 3: provider facts are re-read on every CAS attempt", () => {
  it("finalize: a status that changes between attempts -> the event carries attempt 2's facts", async () => {
    const sb = sandbox();
    await authorized(sb);
    expect((await runPromote("send", sendFlags(sb), deps(sb))).exitCode).toBe(EXIT.ok);
    setStatuses(sb, 777, [[1, "success", "2026-10-16T12:00:05Z"]]);
    const g = scriptedGit(["lease-rejected"]);
    const fin = await runPromote(
      "finalize",
      finalizeFlags(sb),
      deps(sb, {
        git: g.git,
        hooks: {
          beforePush: async (attempt) => {
            if (attempt !== 1) return;
            setStatuses(sb, 777, [
              [1, "success", "2026-10-16T12:00:05Z"],
              [2, "failure", "2026-10-16T12:00:09Z"],
            ]);
            sb.state.live["https://acme.github.io/site/release-manifest.json"] = readFileSync(
              path.join(sb.siteDir, "release-manifest.json"),
              "utf-8",
            );
          },
        },
      }),
    );
    expect(fin.exitCode, JSON.stringify(fin.output)).toBe(EXIT.ok);
    expect(fin.output.attempts).toBe(2);
    expect(fin.output.outcome).toBe("failed");
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      kind: "terminal",
      operation_completed: { state: "failure", status_id: "2" },
      outcome: "failed",
      desired_state_observed: { matches: true },
    });
  });

  it("reconcile (absence): a deployment appearing during the retry -> exit 6, no abandoned", async () => {
    const sb = sandbox();
    await authorized(sb);
    sb.state.create = "timeout";
    await runPromote("send", sendFlags(sb), deps(sb));
    sb.state.now = addSeconds(T0, 3600);
    const before = kinds(sb);
    const g = scriptedGit(["lease-rejected"]);
    const r = await runPromote(
      "reconcile",
      { ...sb.common, ...human, "run-id": RUN_ID, "run-attempt": "1" },
      deps(sb, {
        git: g.git,
        hooks: {
          beforePush: async (attempt) => {
            if (attempt !== 1) return;
            sb.state.deployments.push({
              id: 900,
              sha: HEAD_SHA,
              ref: "main",
              environment: "github-pages",
              created_at: addSeconds(T0, 10),
              payload: {},
              description: null,
            });
          },
        },
      }),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.nonTerminal);
    expect(r.output.status).toBe("candidates_found");
    expect(r.output.candidates).toEqual(["900"]);
    expect(kinds(sb)).toEqual(before);
  });

  it("reconcile (candidate): the candidate's status changes between attempts -> attempt 2's", async () => {
    const sb = sandbox();
    await authorized(sb);
    sb.state.create = "reset-after-accept";
    await runPromote("send", sendFlags(sb), deps(sb));
    setStatuses(sb, 777, [[1, "success", "2026-10-16T12:01:00Z"]]);
    const g = scriptedGit(["lease-rejected"]);
    const r = await runPromote(
      "reconcile",
      {
        ...sb.common,
        ...human,
        "run-id": RUN_ID,
        "run-attempt": "1",
        "candidate-deployment-id": "777",
      },
      deps(sb, {
        git: g.git,
        hooks: {
          beforePush: async (attempt) => {
            if (attempt !== 1) return;
            setStatuses(sb, 777, [
              [1, "success", "2026-10-16T12:01:00Z"],
              [2, "in_progress", "2026-10-16T12:02:00Z"],
            ]);
          },
        },
      }),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.nonTerminal);
    expect(kinds(sb)).not.toContain("terminal");
  });

  it("send: pages artifact expiring between attempts -> refused on attempt 2, no POST", async () => {
    const sb = sandbox();
    await authorized(sb);
    const g = scriptedGit(["lease-rejected"]);
    const r = await runPromote(
      "send",
      sendFlags(sb),
      deps(sb, {
        git: g.git,
        hooks: {
          beforePush: async (attempt) => {
            if (attempt !== 1) return;
            const pages = sb.state.artifacts[EXECUTOR_RUN_ID]?.[0];
            if (pages) pages.expired = true;
          },
        },
      }),
    );
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(sb.state.posts).toBe(0);
    expect(kinds(sb)).not.toContain("effect_send");
  });
});

// ---------------------------------------------------------------------------------------------

describe("fix 4: deployment status tie-break", () => {
  const AT = "2026-10-16T12:00:05Z";
  function provider(body: string) {
    return new GitHubProvider({
      apiBase: "https://api.test",
      repository: "acme/site",
      fetch: async () => new Response(body, { status: 200 }),
    });
  }

  it("ids beyond Number.MAX_SAFE_INTEGER (JSON numbers) order by their exact value", async () => {
    for (const order of [
      [9007199254740992n, 9007199254740993n],
      [9007199254740993n, 9007199254740992n],
    ]) {
      const body = `[${order
        .map(
          (id) =>
            `{"id":${id},"state":"${id === 9007199254740993n ? "success" : "in_progress"}","created_at":"${AT}"}`,
        )
        .join(",")}]`;
      const { latest, problems } = await provider(body).listDeploymentStatuses("1");
      expect(problems).toEqual([]);
      expect(latest).toMatchObject({ id: "9007199254740993", state: "success" });
    }
  });

  it("ids beyond 2^64 as strings order by BigInt", async () => {
    const body = JSON.stringify([
      { id: "18446744073709551616", state: "in_progress", created_at: AT },
      { id: "18446744073709551617", state: "success", created_at: AT },
    ]);
    const { latest } = await provider(body).listDeploymentStatuses("1");
    expect(latest?.id).toBe("18446744073709551617");
  });

  it("a non-decimal id is a problem: no latest, so no terminal can be derived", async () => {
    const body = JSON.stringify([
      { id: "12a", state: "success", created_at: AT },
      { id: 3, state: "success", created_at: AT },
    ]);
    const { latest, problems } = await provider(body).listDeploymentStatuses("1");
    expect(latest).toBeNull();
    expect(problems).toHaveLength(1);
  });

  it("finalize with a malformed status id writes nothing and exits 6", async () => {
    const sb = sandbox();
    await authorized(sb);
    await runPromote("send", sendFlags(sb), deps(sb));
    setStatuses(sb, 777, [["-1", "success", AT]]);
    const before = remoteHead(sb);
    const fin = await runPromote("finalize", finalizeFlags(sb, { "max-wait-s": "0" }), deps(sb));
    expect(fin.exitCode).toBe(EXIT.nonTerminal);
    expect(fin.output.problems).toHaveLength(1);
    expect(remoteHead(sb)).toBe(before);
  });

  it("quoteUnsafeIntegers leaves strings, safe numbers and fractions alone", () => {
    const text = '{"a":"x\\"9007199254740993","b":12345678901234567890,"c":-42,"d":1.5e300}';
    expect(JSON.parse(quoteUnsafeIntegers(text))).toEqual({
      a: 'x"9007199254740993',
      b: "12345678901234567890",
      c: -42,
      d: 1.5e300,
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("fix 5: the Pages artifact belongs to the executor attempt", () => {
  async function authorizedWithExecutorAttempt(sb: Sandbox, attempt: number) {
    const approval = grant(sb);
    const r = await runPromote(
      "authorize",
      { ...authorizeFlags(sb, approval.event_id), "executor-run-attempt": String(attempt) },
      deps(sb),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
  }

  it("records pages_artifact.name = github-pages-<executor run>-<attempt>", async () => {
    const sb = sandbox();
    await authorized(sb);
    expect((await runPromote("send", sendFlags(sb), deps(sb))).exitCode).toBe(EXIT.ok);
    const send = remoteLedger(sb).find((e) => e.kind === "effect_send");
    expect(send?.pages_artifact).toEqual({
      id: "9001",
      name: `github-pages-${EXECUTOR_RUN_ID}-1`,
      archive_digest: sha256Bytes(readFileSync(sb.pagesArchivePath)),
      content_manifest_digest: (
        remoteLedger(sb).find((e) => e.kind === "authorized") as {
          resolved: { source_artifact: { content_manifest_digest: string } };
        }
      ).resolved.source_artifact.content_manifest_digest,
    });
  });

  it("another attempt's artifact (github-pages-<run>-1 for executor attempt 2) is refused", async () => {
    const sb = sandbox();
    await authorizedWithExecutorAttempt(sb, 2);
    const r = await runPromote("send", sendFlags(sb), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/github-pages-2002-2/);
    expect(sb.state.posts).toBe(0);
    expect(kinds(sb)).not.toContain("effect_send");
  });

  it("duplicate name / expired / wrong id / foreign workflow_run are refused", async () => {
    type A = NonNullable<Sandbox["state"]["artifacts"][string]>[number];
    const cases: Array<(list: A[]) => void> = [
      (list) => list.push({ ...(list[0] as A), id: 9002 }),
      (list) => {
        (list[0] as A).expired = true;
      },
      (list) => {
        (list[0] as A).id = 9003;
      },
      (list) => {
        (list[0] as A).workflow_run = { id: 3003 };
      },
    ];
    for (const mutate of cases) {
      const sb = sandbox();
      await authorized(sb);
      mutate(sb.state.artifacts[EXECUTOR_RUN_ID] as A[]);
      const r = await runPromote("send", sendFlags(sb), deps(sb));
      expect(r.exitCode).toBe(EXIT.precondition);
      expect(sb.state.posts).toBe(0);
    }
  });
});
