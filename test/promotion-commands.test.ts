// End-to-end `promote <sub>` behavior through runPromote: real git (bare repo remote in a tmp
// dir), fake GitHub behind an injected fetch. Covers the three state-machine paths, expiry,
// CAS races / read-back, the four send crash windows, reconcile classification, late effects,
// break_glass, and artifact binding.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPromote } from "../src/promotion/commands.js";
import { EXIT } from "../src/promotion/types.js";
import {
  HEAD_SHA,
  RUN_ID,
  SHA,
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
  remoteHead,
  remoteLedger,
  sendFlags,
  writeAuthority,
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

const kinds = (sb: Sandbox) => remoteLedger(sb).map((e) => e.kind);

function grant(sb: Sandbox, extra: Partial<Parameters<typeof makeApproval>[0]> = {}) {
  const approval = makeApproval({ subject: sb.subject, ...extra });
  writeAuthority(sb, [approval]);
  return approval;
}

async function authorized(sb: Sandbox) {
  const approval = grant(sb);
  const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
  expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
  return approval;
}

function setStatuses(sb: Sandbox, id: number, states: Array<[number, string, string]>) {
  sb.state.statuses[String(id)] = states.map(([sid, state, at]) => ({
    id: sid,
    state,
    created_at: at,
  }));
}

describe("promote: normal path", () => {
  it("authorize -> send -> finalize, with lock while open", async () => {
    const sb = sandbox();
    await authorized(sb);
    expect(kinds(sb)).toEqual(["authority_ingested", "authorized"]);

    let lock = await runPromote("lock-status", sb.common, deps(sb));
    expect(lock.output.locked).toBe(true);

    const send = await runPromote("send", sendFlags(sb), deps(sb));
    expect(send.exitCode, JSON.stringify(send.output)).toBe(EXIT.ok);
    expect(sb.state.posts).toBe(1);
    expect(JSON.stringify(send.output)).not.toContain("SECRET-OIDC-TOKEN");
    expect(JSON.stringify(remoteLedger(sb))).not.toContain("SECRET-OIDC-TOKEN");
    expect(kinds(sb).slice(-2)).toEqual(["effect_send", "effect_requested"]);

    setStatuses(sb, 777, [
      [1, "queued", "2026-10-16T12:00:01Z"],
      [3, "success", "2026-10-16T12:00:05Z"],
      [2, "in_progress", "2026-10-16T12:00:05Z"],
    ]);
    const contentDigest = (sb.bundle.artifacts as Array<{ digest: string }>)[0]?.digest as string;
    sb.state.live["https://acme.github.io/site/release-manifest.json"] = readFileSync(
      path.join(sb.siteDir, "release-manifest.json"),
      "utf-8",
    );
    const fin = await runPromote(
      "finalize",
      {
        ...sb.common,
        "run-id": RUN_ID,
        "run-attempt": "1",
        "page-url": "https://acme.github.io/site/",
        "expected-digest": contentDigest,
      },
      deps(sb),
    );
    expect(fin.exitCode, JSON.stringify(fin.output)).toBe(EXIT.ok);
    const terminal = remoteLedger(sb).at(-1) as Record<string, unknown>;
    expect(terminal.kind).toBe("terminal");
    // statuses: same created_at -> higher id wins (3 = success)
    expect(terminal.operation_completed).toMatchObject({ state: "success", status_id: "3" });
    expect(terminal.outcome).toBe("completed");
    expect(terminal.desired_state_observed).toMatchObject({
      matches: true,
      expected_digest: contentDigest,
    });

    lock = await runPromote("lock-status", sb.common, deps(sb));
    expect(lock.output.locked).toBe(false);
  });

  it("finalize on a non-terminal deployment writes nothing and exits 6", async () => {
    const sb = sandbox();
    await authorized(sb);
    await runPromote("send", sendFlags(sb), deps(sb));
    setStatuses(sb, 777, [[1, "in_progress", "2026-10-16T12:00:01Z"]]);
    const before = remoteHead(sb);
    const fin = await runPromote(
      "finalize",
      {
        ...sb.common,
        "run-id": RUN_ID,
        "run-attempt": "1",
        "page-url": "https://acme.github.io/site/",
        "expected-digest": (sb.bundle.artifacts as Array<{ digest: string }>)[0]?.digest as string,
        "max-wait-s": "20",
      },
      deps(sb),
    );
    expect(fin.exitCode).toBe(EXIT.nonTerminal);
    expect(remoteHead(sb)).toBe(before);
  });

  it("failure state normalizes to outcome failed", async () => {
    const sb = sandbox();
    await authorized(sb);
    await runPromote("send", sendFlags(sb), deps(sb));
    setStatuses(sb, 777, [[1, "error", "2026-10-16T12:00:01Z"]]);
    const fin = await runPromote(
      "finalize",
      {
        ...sb.common,
        "run-id": RUN_ID,
        "run-attempt": "1",
        "page-url": "https://acme.github.io/site/",
        "expected-digest": (sb.bundle.artifacts as Array<{ digest: string }>)[0]?.digest as string,
      },
      deps(sb),
    );
    expect(fin.exitCode).toBe(EXIT.ok);
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      outcome: "failed",
      desired_state_observed: null,
    });
  });
});

describe("promote authorize: consume preconditions", () => {
  it("expiry: margin == window is refused, margin > window accepted", async () => {
    const sb = sandbox();
    grant(sb, { expires_at: addSeconds(T0, 900) });
    const approval = makeApproval({ subject: sb.subject, expires_at: addSeconds(T0, 900) });
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/expires too soon/);
    expect(remoteLedger(sb)).toEqual([]);

    const sb2 = sandbox();
    const ok = grant(sb2, { expires_at: addSeconds(T0, 901) });
    const r2 = await runPromote("authorize", authorizeFlags(sb2, ok.event_id), deps(sb2));
    expect(r2.exitCode, JSON.stringify(r2.output)).toBe(EXIT.ok);
  });

  it("pre-push re-check: approval expiring between evaluation and push writes nothing", async () => {
    const sb = sandbox();
    const approval = grant(sb, { expires_at: addSeconds(T0, 1000) });
    // fetchNow calls inside the CAS: evaluation (T0, ok) then pre-push (T0+200 -> 800s left).
    const d = deps(sb);
    const inner = d.fetch;
    let nowCalls = 0;
    d.fetch = async (url, init) => {
      if (url === "https://api.test/repos/acme/site") {
        nowCalls++;
        sb.state.nowQueue = nowCalls >= 2 ? [addSeconds(T0, 200)] : [];
      }
      return inner(url, init);
    };
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), d);
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/pre-push/);
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("approval consumed once: a second promotion (other target too) is refused", async () => {
    const sb = sandbox();
    const approval = await authorized(sb);
    addSourceRun(sb, "1002", 1);
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, approval.event_id, "1002"),
      deps(sb),
    );
    expect(r.exitCode).toBe(EXIT.precondition);
  });

  it("revoke ingested before consume refuses the consume", async () => {
    const sb = sandbox();
    const approval = makeApproval({ subject: sb.subject });
    const revoke = makeApproval({
      kind: "approval_revoked",
      subject: sb.subject,
      occurred_at: "2026-10-16T01:00:00Z",
      revoked_approval_event_id: approval.event_id,
    });
    writeAuthority(sb, [revoke, approval]); // file order does not matter: grants ingest first
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/revoked/);
    const ing = await runPromote("ingest", sb.common, deps(sb));
    expect(ing.exitCode).toBe(EXIT.ok);
    expect(kinds(sb)).toEqual(["authority_ingested", "authority_ingested"]);
  });

  it("revoke after consume is recorded as revoked_after_consume; promotion continues", async () => {
    const sb = sandbox();
    const approval = await authorized(sb);
    const revoke = makeApproval({
      kind: "approval_revoked",
      subject: sb.subject,
      occurred_at: "2026-10-16T01:00:00Z",
      revoked_approval_event_id: approval.event_id,
    });
    writeAuthority(sb, [approval, revoke]);
    const ing = await runPromote("ingest", sb.common, deps(sb));
    expect(ing.exitCode).toBe(EXIT.ok);
    expect(kinds(sb).slice(-2)).toEqual(["authority_ingested", "revoked_after_consume"]);
    const send = await runPromote("send", sendFlags(sb), deps(sb));
    expect(send.exitCode).toBe(EXIT.ok);
  });

  it("ingest with nothing new does not commit", async () => {
    const sb = sandbox();
    grant(sb);
    expect((await runPromote("ingest", sb.common, deps(sb))).output.committed).toBe(true);
    const head = remoteHead(sb);
    const again = await runPromote("ingest", sb.common, deps(sb));
    expect(again.output.committed).toBe(false);
    expect(remoteHead(sb)).toBe(head);
  });

  it("another run_attempt is a separate promotion and is locked while the first is open", async () => {
    const sb = sandbox();
    await authorized(sb);
    const second = makeApproval({ subject: sb.subject, occurred_at: "2026-10-16T02:00:00Z" });
    writeAuthority(sb, [makeApproval({ subject: sb.subject }), second]);
    addSourceRun(sb, RUN_ID, 2);
    const r = await runPromote(
      "authorize",
      authorizeFlags(sb, second.event_id, RUN_ID, 2),
      deps(sb),
    );
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(r.output.reasons).toEqual([`open_promotion:${RUN_ID}:1`]);
  });

  it("bundle/receipt binding mismatch is refused before any provider call but the artifact listing", async () => {
    // the listing is needed first: the evidence zip must match the API digest before
    // bundle.json / receipt.json are extracted from it
    const sb = sandbox();
    const approval = grant(sb, { subject: { ...sb.subject, bundle_digest: SHA("9") } });
    const urls: string[] = [];
    const d = deps(sb);
    const inner = d.fetch;
    d.fetch = (u, i) => {
      urls.push(String(u));
      return inner(u, i);
    };
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), d);
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(new RegExp(`/actions/runs/${RUN_ID}/artifacts`));
  });
});

describe("promote authorize: source artifact binding", () => {
  it("name mismatch / expired / archive digest mismatch are refused", async () => {
    const cases: Array<(sb: Sandbox) => void> = [
      (sb) => {
        const a = sb.state.artifacts[RUN_ID]?.[0];
        if (a) a.name = `site-dist-${RUN_ID}-9`;
      },
      (sb) => {
        const a = sb.state.artifacts[RUN_ID]?.[0];
        if (a) a.expired = true;
      },
      (sb) => {
        const a = sb.state.artifacts[RUN_ID]?.[0];
        if (a) a.digest = SHA("0");
      },
    ];
    for (const mutate of cases) {
      const sb = sandbox();
      const approval = grant(sb);
      mutate(sb);
      const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
      expect(r.exitCode).toBe(EXIT.precondition);
      expect(remoteLedger(sb)).toEqual([]);
    }
  });

  it("archive digest and content manifest digest are checked independently", async () => {
    // archive bytes fine, content tampered -> content error
    const sb = sandbox();
    const approval = grant(sb);
    writeFileSync(path.join(sb.siteDir, "index.html"), "<h1>tampered</h1>\n");
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/content manifest/);

    // content fine, archive bytes differ -> archive error
    const sb2 = sandbox();
    const approval2 = grant(sb2);
    writeFileSync(sb2.archivePath, "other-bytes");
    const r2 = await runPromote("authorize", authorizeFlags(sb2, approval2.event_id), deps(sb2));
    expect(r2.exitCode).toBe(EXIT.precondition);
    expect(String(r2.output.error)).toMatch(/archive/);

    // recorded values are distinct concepts
    const sb3 = sandbox();
    await authorized(sb3);
    const auth = remoteLedger(sb3)[1] as {
      resolved: { source_artifact: { archive_digest: string; content_manifest_digest: string } };
    };
    expect(auth.resolved.source_artifact.archive_digest).not.toBe(
      auth.resolved.source_artifact.content_manifest_digest,
    );
    expect(auth.resolved.source_artifact.content_manifest_digest).toBe(
      (sb3.bundle.artifacts as Array<{ digest: string }>)[0]?.digest,
    );
  });
});

describe("promote: CAS and ledger integrity", () => {
  it("lease rejection rebuilds events from the new head (no stale events reused)", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const other = newLedgerClone(sb, "other");
    const d = deps(sb, {
      hooks: {
        beforePush: async (attempt) => {
          if (attempt !== 1) return;
          const ing = await runPromote("ingest", { ...sb.common, "ledger-repo": other }, deps(sb));
          expect(ing.output.committed).toBe(true);
        },
      },
    });
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), d);
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(r.output.attempts).toBe(2);
    expect(kinds(sb)).toEqual(["authority_ingested", "authorized"]);
  });

  it("CAS retries exhausted -> exit 4, nothing of ours written", async () => {
    const sb = sandbox({ max_cas_retries: 2 });
    const approval = grant(sb);
    const other = newLedgerClone(sb, "other");
    let n = 0;
    const d = deps(sb, {
      hooks: {
        beforePush: async () => {
          // a racing writer appends a harmless ingest every time
          n++;
          writeAuthority(sb, [
            approval,
            makeApproval({ subject: sb.subject, occurred_at: `2026-10-16T0${n}:30:00Z` }),
          ]);
          await runPromote("ingest", { ...sb.common, "ledger-repo": other }, deps(sb));
        },
      },
    });
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), d);
    expect(r.exitCode).toBe(EXIT.casExhausted);
    expect(kinds(sb)).not.toContain("authorized");
  });

  it("history rewritten after our push -> exit 5", async () => {
    const sb = sandbox();
    const approval = grant(sb);
    const d = deps(sb, {
      hooks: {
        afterPush: async () => {
          forceRemoteCommit(sb, { "promotion-events.jsonl": "" }, []);
        },
      },
    });
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), d);
    expect(r.exitCode).toBe(EXIT.readBackMismatch);
  });

  it("malformed JSONL / extra file / merge commit / non-append history -> exit 1, lock-status locked", async () => {
    const scenarios: Array<(sb: Sandbox) => void> = [
      (sb) => forceRemoteCommit(sb, { "promotion-events.jsonl": "{not json\n" }, []),
      (sb) => forceRemoteCommit(sb, { "promotion-events.jsonl": "", "evil.txt": "x" }, []),
      (sb) => {
        const a = forceRemoteCommit(sb, { "promotion-events.jsonl": "" }, []);
        const b = forceRemoteCommit(sb, { "promotion-events.jsonl": "" }, [a]);
        forceRemoteCommit(sb, { "promotion-events.jsonl": "" }, [a, b]);
      },
      (sb) => {
        const a = forceRemoteCommit(sb, { "promotion-events.jsonl": '{"a":1}\n' }, []);
        forceRemoteCommit(sb, { "promotion-events.jsonl": "" }, [a]);
      },
    ];
    for (const make of scenarios) {
      const sb = sandbox();
      grant(sb);
      make(sb);
      const head = remoteHead(sb);
      const r = await runPromote("ingest", sb.common, deps(sb));
      expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ledgerInvalid);
      expect(remoteHead(sb)).toBe(head);
      const lock = await runPromote("lock-status", sb.common, deps(sb));
      expect(lock.exitCode).toBe(EXIT.ok);
      expect(lock.output.locked).toBe(true);
    }
  });

  it("config/remote mismatch is a usage error", async () => {
    const sb = sandbox();
    git(sb.ledger, ["remote", "set-url", "origin", path.join(sb.root, "elsewhere.git")]);
    const r = await runPromote("lock-status", sb.common, deps(sb));
    expect(r.exitCode).toBe(EXIT.usage);
  });
});

describe("promote send: crash windows never POST twice", () => {
  async function rerunRefused(sb: Sandbox) {
    const again = await runPromote("send", sendFlags(sb), deps(sb));
    expect(again.exitCode).toBe(EXIT.precondition);
  }

  it("crash after effect_send CAS, before POST", async () => {
    const sb = sandbox();
    await authorized(sb);
    const r = await runPromote(
      "send",
      sendFlags(sb),
      deps(sb, { hooks: { afterEffectSend: async () => Promise.reject(new Error("crash")) } }),
    );
    expect(r.exitCode).not.toBe(EXIT.ok);
    await rerunRefused(sb);
    expect(sb.state.posts).toBe(0);
    expect(kinds(sb).at(-1)).toBe("effect_send");
  });

  it("POST timeout records effect_requested(null) and exits 6", async () => {
    const sb = sandbox();
    await authorized(sb);
    sb.state.create = "timeout";
    const r = await runPromote("send", sendFlags(sb), deps(sb));
    expect(r.exitCode).toBe(EXIT.nonTerminal);
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      kind: "effect_requested",
      deployment_id: null,
      response_observed: false,
    });
    await rerunRefused(sb);
    expect(sb.state.posts).toBe(1);
  });

  it("accepted but response lost, then reconcile finds the deployment", async () => {
    const sb = sandbox();
    await authorized(sb);
    sb.state.create = "reset-after-accept";
    expect((await runPromote("send", sendFlags(sb), deps(sb))).exitCode).toBe(EXIT.nonTerminal);
    await rerunRefused(sb);
    expect(sb.state.posts).toBe(1);

    const human = {
      "confirmed-full-listing": true,
      "observed-at": "2026-10-16T13:00:00Z",
      "actor-login": "octocat",
    };
    const flags = { ...sb.common, ...human, "run-id": RUN_ID, "run-attempt": "1" };
    const list = await runPromote("reconcile", flags, deps(sb));
    expect(list.exitCode).toBe(EXIT.nonTerminal);
    expect(list.output.candidates).toEqual(["777"]);

    setStatuses(sb, 777, [[1, "success", "2026-10-16T12:01:00Z"]]);
    const rec = await runPromote(
      "reconcile",
      { ...flags, "candidate-deployment-id": "777" },
      deps(sb),
    );
    expect(rec.exitCode, JSON.stringify(rec.output)).toBe(EXIT.ok);
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      kind: "terminal",
      via: "reconcile",
      resolution: "operation_completed",
      deployment_id: "777",
      outcome: "completed",
    });
  });

  it("crash after id received, before effect_requested CAS", async () => {
    const sb = sandbox();
    await authorized(sb);
    const r = await runPromote(
      "send",
      sendFlags(sb),
      deps(sb, { hooks: { afterPost: async () => Promise.reject(new Error("crash")) } }),
    );
    expect(r.exitCode).not.toBe(EXIT.ok);
    expect(kinds(sb).at(-1)).toBe("effect_send");
    await rerunRefused(sb);
    expect(sb.state.posts).toBe(1);
  });
});

describe("promote reconcile: classification", () => {
  const human = {
    "confirmed-full-listing": true,
    "observed-at": "2026-10-16T14:00:00Z",
    "actor-login": "octocat",
  };

  async function unknownSend(sb: Sandbox) {
    await authorized(sb);
    sb.state.create = "timeout";
    await runPromote("send", sendFlags(sb), deps(sb));
    sb.state.create = "created";
  }

  it("zero matches after the settle window -> abandoned_no_effect, then a late effect locks", async () => {
    const sb = sandbox();
    await unknownSend(sb);
    const flags = { ...sb.common, ...human, "run-id": RUN_ID, "run-attempt": "1" };

    const early = await runPromote("reconcile", flags, deps(sb));
    expect(early.exitCode).toBe(EXIT.nonTerminal);
    expect(early.output.status).toBe("settle_window_open");

    sb.state.now = addSeconds(T0, 3600);
    const r = await runPromote("reconcile", flags, deps(sb));
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      resolution: "abandoned_no_effect",
      outcome: "abandoned_no_effect",
      deployment_id: null,
    });
    expect((await runPromote("lock-status", sb.common, deps(sb))).output.locked).toBe(false);

    // the provider later shows a deployment carrying this promotion's marker: the next write
    // detects it and locks, and it can then be attributed to the abandoned promotion
    sb.state.deployments.push({
      id: 900,
      sha: HEAD_SHA,
      ref: `${HEAD_SHA}:${RUN_ID}:1`,
      environment: "github-pages",
      created_at: addSeconds(T0, 10),
      payload: {},
      description: null,
    });
    setStatuses(sb, 900, [[1, "success", addSeconds(T0, 20)]]);
    const next = makeApproval({ subject: sb.subject, occurred_at: "2026-10-16T03:00:00Z" });
    writeAuthority(sb, [makeApproval({ subject: sb.subject }), next]);
    addSourceRun(sb, RUN_ID, 2);
    const blocked = await runPromote(
      "authorize",
      authorizeFlags(sb, next.event_id, RUN_ID, 2),
      deps(sb),
    );
    expect(blocked.exitCode).toBe(EXIT.precondition);
    expect(kinds(sb).at(-1)).toBe("late_effect_detected");
    const lock = await runPromote("lock-status", sb.common, deps(sb));
    expect(lock.output.locked).toBe(true);
    const pending = lock.output.pending_late_effects as Array<{ event_id: string }>;

    const res = await runPromote(
      "reconcile",
      { ...sb.common, ...human, "late-effect-event-id": pending[0]?.event_id as string },
      deps(sb),
    );
    expect(res.exitCode, JSON.stringify(res.output)).toBe(EXIT.ok);
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      kind: "late_effect_resolved",
      resolution: "attributed_to_promotion",
    });
    expect((await runPromote("lock-status", sb.common, deps(sb))).output.locked).toBe(false);
  });

  it("multiple matches / incomplete listing are exit 6 and write nothing", async () => {
    const sb = sandbox();
    await unknownSend(sb);
    sb.state.now = addSeconds(T0, 4000);
    const flags = { ...sb.common, ...human, "run-id": RUN_ID, "run-attempt": "1" };
    for (const id of [801, 802]) {
      sb.state.deployments.push({
        id,
        sha: HEAD_SHA,
        ref: "x",
        environment: "github-pages",
        created_at: addSeconds(T0, 5),
        payload: {},
        description: null,
      });
    }
    const head = remoteHead(sb);
    const multi = await runPromote("reconcile", flags, deps(sb));
    expect(multi.exitCode).toBe(EXIT.nonTerminal);
    // provider order (newest first); the set is what matters.
    expect([...(multi.output.candidates as string[])].sort()).toEqual(["801", "802"]);

    sb.state.deployments = [];
    sb.state.deploymentsListFails = true;
    const inc = await runPromote("reconcile", flags, deps(sb));
    expect(inc.exitCode).toBe(EXIT.nonTerminal);
    expect(inc.output.status).toBe("listing_incomplete");

    sb.state.deploymentsListFails = false;
    sb.state.pagesList = "error";
    const incPages = await runPromote("reconcile", flags, deps(sb));
    expect(incPages.exitCode).toBe(EXIT.nonTerminal);
    expect(remoteHead(sb)).toBe(head);
  });
});

describe("promote: break_glass", () => {
  function breakGlassApproval(sb: Sandbox) {
    const approval = makeApproval({
      kind: "break_glass_approve",
      subject: sb.subject,
      recorded_after_side_effect: true,
    });
    writeAuthority(sb, [approval]);
    sb.state.deployments.push({
      id: 555,
      sha: HEAD_SHA,
      ref: "main",
      environment: "github-pages",
      created_at: "2026-10-16T11:00:00Z",
      payload: {},
      description: null,
    });
    setStatuses(sb, 555, [[1, "success", "2026-10-16T11:01:00Z"]]);
    return approval;
  }

  it("authorized(external_effect) -> finalize terminal; send refused", async () => {
    const sb = sandbox();
    const approval = breakGlassApproval(sb);
    const r = await runPromote(
      "authorize",
      {
        ...authorizeFlags(sb, approval.event_id),
        "break-glass": true,
        "external-deployment-id": "555",
      },
      deps(sb),
    );
    expect(r.exitCode, JSON.stringify(r.output)).toBe(EXIT.ok);
    expect(remoteLedger(sb).at(-1)).toMatchObject({
      approval_kind: "break_glass_approve",
      recorded_after_side_effect: true,
      external_effect: { deployment_id: "555" },
    });
    expect((await runPromote("send", sendFlags(sb), deps(sb))).exitCode).toBe(EXIT.precondition);
    const fin = await runPromote(
      "finalize",
      {
        ...sb.common,
        "run-id": RUN_ID,
        "run-attempt": "1",
        "page-url": "https://acme.github.io/site/",
        "expected-digest": (sb.bundle.artifacts as Array<{ digest: string }>)[0]?.digest as string,
      },
      deps(sb),
    );
    expect(fin.exitCode, JSON.stringify(fin.output)).toBe(EXIT.ok);
    expect(remoteLedger(sb).at(-1)).toMatchObject({ kind: "terminal", deployment_id: "555" });
    expect(sb.state.posts).toBe(0);
  });

  it("external effect with a different sha is refused", async () => {
    const sb = sandbox();
    const approval = breakGlassApproval(sb);
    (sb.state.deployments[0] as { sha: string }).sha = "b".repeat(40);
    const r = await runPromote(
      "authorize",
      {
        ...authorizeFlags(sb, approval.event_id),
        "break-glass": true,
        "external-deployment-id": "555",
      },
      deps(sb),
    );
    expect(r.exitCode).toBe(EXIT.precondition);
    expect(String(r.output.error)).toMatch(/sha/);
  });

  it("break_glass approval without --break-glass is refused (kind mismatch)", async () => {
    const sb = sandbox();
    const approval = breakGlassApproval(sb);
    const r = await runPromote("authorize", authorizeFlags(sb, approval.event_id), deps(sb));
    expect(r.exitCode).toBe(EXIT.precondition);
  });
});
