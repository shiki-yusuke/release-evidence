// Schema and fold rules of the promotion ledger, on hand-built event sequences (no git, no
// provider): kind-specific schema constraints, the three legal paths and every forbidden
// transition, single consumption across targets, revoke classification, and the lock definition.

import { describe, expect, it } from "vitest";
import { buildEvent, foldPromotionLedger, validatePromotionEvent } from "../src/promotion/fold.js";
import type {
  ApprovalEvent,
  PromotionEvent,
  PromotionEventDraft,
  PromotionId,
  PromotionTarget,
} from "../src/promotion/types.js";
import { HEAD_SHA, SHA, jcs, makeApproval } from "./promotion-fixtures.js";

const TARGET: PromotionTarget = { repository: "acme/site", environment: "github-pages" };
const OTHER: PromotionTarget = { repository: "acme/other", environment: "github-pages" };
const AT = "2026-10-16T12:00:00Z";
const SUBJECT = {
  receipt_digest: SHA("1"),
  receipt_semantic_digest: SHA("2"),
  bundle_digest: SHA("3"),
  selection_manifest_digest: SHA("4"),
  target: "production" as const,
};
const PID = (run_attempt = 1, run_id = "1001"): PromotionId => ({ run_id, run_attempt });

const ev = (d: PromotionEventDraft, target = TARGET, at = AT) => buildEvent(d, target, at);

function ingest(a: ApprovalEvent, target = TARGET): PromotionEvent {
  return ev(
    {
      kind: "authority_ingested",
      authority_event: a,
      source: {
        ref: "main",
        commit_oid: "f".repeat(40),
        path: "release-approval/x/events.jsonl",
        line: 1,
      },
    },
    target,
  );
}

function authorized(
  a: ApprovalEvent,
  pid = PID(),
  extra: Partial<Extract<PromotionEventDraft, { kind: "authorized" }>> = {},
  target = TARGET,
): PromotionEvent {
  return ev(
    {
      kind: "authorized",
      promotion_id: pid,
      approval_event_id: a.event_id,
      approval_kind: a.kind as "approval_granted",
      recorded_after_side_effect: a.recorded_after_side_effect === true,
      subject_digest: jcs(a.subject),
      subject: a.subject,
      site_url: "https://acme.github.io/site/",
      evaluated_at: AT,
      time_source: "github_api_date",
      expiry_safety_window_s: 900,
      expires_at: a.expires_at as string,
      executor: { run_id: "2002", run_attempt: 1 },
      resolved: {
        source_run: {
          run_id: pid.run_id,
          run_attempt: pid.run_attempt,
          head_sha: HEAD_SHA,
          conclusion: "success",
        },
        source_artifact: {
          id: "5000",
          name: `site-dist-${pid.run_id}-${pid.run_attempt}`,
          archive_digest: SHA("5"),
          content_manifest_digest: SHA("6"),
          evidence_artifact: {
            id: "5001",
            name: `release-evidence-out-${pid.run_id}-${pid.run_attempt}`,
            archive_digest: SHA("9"),
          },
        },
        bundle_digest: a.subject.bundle_digest,
        receipt_digest: a.subject.receipt_digest,
        receipt_promotion_id: null,
        derived_promotion_id: { ...pid, derived_from: "artifact_name" },
        resolver_source: { store: "github_actions_artifacts", namespace: "acme/site/x" },
      },
      external_effect: null,
      ...extra,
    },
    target,
  );
}

function send(pid = PID()): PromotionEvent {
  return ev({
    kind: "effect_send",
    promotion_id: pid,
    bundle_digest: SUBJECT.bundle_digest,
    source_artifact: {
      id: "5000",
      name: `site-dist-${pid.run_id}-${pid.run_attempt}`,
      archive_digest: SHA("5"),
      content_manifest_digest: SHA("6"),
      evidence_artifact: {
        id: "5001",
        name: `release-evidence-out-${pid.run_id}-${pid.run_attempt}`,
        archive_digest: SHA("9"),
      },
    },
    pages_artifact: {
      id: "9001",
      name: "github-pages-2002-1",
      archive_digest: SHA("7"),
      content_manifest_digest: SHA("6"),
    },
    request_fingerprint: SHA("8"),
    pages_build_version: `${HEAD_SHA}:${pid.run_id}:${pid.run_attempt}`,
    send_at: AT,
  });
}

function requested(deployment_id: string | null, pid = PID()): PromotionEvent {
  return ev({
    kind: "effect_requested",
    promotion_id: pid,
    deployment_id,
    status_url: null,
    response_observed: deployment_id !== null,
    request_fingerprint: SHA("8"),
    requested_at: AT,
  });
}

const HUMAN = { confirmed_full_listing: true as const, observed_at: AT, actor_login: "octocat" };
const CRITERIA = { environment: "github-pages" as const, sha: HEAD_SHA, created_at_not_before: AT };

function completed(
  deployment_id: string,
  pid = PID(),
  via: "provider_poll" | "reconcile" = "provider_poll",
) {
  return ev({
    kind: "terminal",
    promotion_id: pid,
    deployment_id,
    via,
    resolution: "operation_completed",
    operation_completed: { state: "success", status_id: "1", observed_at: AT },
    desired_state_observed: null,
    outcome: "completed",
    reconcile:
      via === "reconcile" ? { human_confirmation: HUMAN, listing: null, criteria: CRITERIA } : null,
  });
}

function abandoned(pid = PID()): PromotionEvent {
  return ev({
    kind: "terminal",
    promotion_id: pid,
    deployment_id: null,
    via: "reconcile",
    resolution: "abandoned_no_effect",
    operation_completed: null,
    desired_state_observed: null,
    outcome: "abandoned_no_effect",
    reconcile: {
      human_confirmation: HUMAN,
      listing: {
        pages_fetched: 1,
        total: 0,
        newest_created_at: null,
        oldest_created_at: null,
        pages_listing: "unsupported",
      },
      criteria: CRITERIA,
    },
  });
}

const grant = makeApproval({ subject: SUBJECT });
const grant2 = makeApproval({ subject: SUBJECT, occurred_at: "2026-10-16T01:00:00Z" });

function problemsOf(events: PromotionEvent[]): string[] {
  return foldPromotionLedger(events).problems;
}

describe("promotion event schema", () => {
  const base = completed("777") as unknown as Record<string, unknown>;

  it("accepts every event the builders produce", () => {
    for (const e of [
      ingest(grant),
      authorized(grant),
      send(),
      requested(null),
      requested("7"),
      base,
      abandoned(),
    ]) {
      expect(validatePromotionEvent(e)).toEqual([]);
    }
  });

  it("rejects kind-specific violations and normalization-table breaks", () => {
    const bad: Array<Record<string, unknown>> = [
      { ...base, operation_completed: { state: "in_progress", status_id: "1", observed_at: AT } },
      { ...base, operation_completed: { state: "queued", status_id: "1", observed_at: AT } },
      { ...base, operation_completed: { state: "failure", status_id: "1", observed_at: AT } }, // outcome completed
      { ...base, outcome: "abandoned_no_effect" },
      { ...base, deployment_id: null },
      { ...base, reconcile: { human_confirmation: HUMAN, listing: null, criteria: CRITERIA } }, // provider_poll + reconcile
      {
        ...(abandoned() as unknown as Record<string, unknown>),
        via: "provider_poll",
        reconcile: null,
      },
      { ...(abandoned() as unknown as Record<string, unknown>), reconcile: null },
      { ...base, extra: 1 },
      Object.fromEntries(Object.entries(base).filter(([k]) => k !== "promotion_id")),
      {
        ...(authorized(grant) as unknown as Record<string, unknown>),
        recorded_after_side_effect: true,
      },
      {
        ...(authorized(grant) as unknown as Record<string, unknown>),
        external_effect: {
          deployment_id: "1",
          sha: HEAD_SHA,
          environment: "github-pages",
          created_at: AT,
          observed_state: "success",
        },
      },
      {
        ...(send() as unknown as Record<string, unknown>),
        request_fingerprint: `sha256:${"A".repeat(64)}`,
      },
      { ...(send() as unknown as Record<string, unknown>), bundle_digest: "sha256:abc" },
      { ...base, occurred_at: "2026-02-30T00:00:00Z" },
      { ...base, occurred_at: "2026-10-16T12:00:00+09:00" },
      { ...base, target: { repository: "Acme/Site", environment: "github-pages" } },
      { ...base, actor: "human" },
      { ...base, event_id: "short" },
    ];
    for (const b of bad) {
      expect(validatePromotionEvent(b), JSON.stringify(b)).not.toEqual([]);
    }
  });

  it("rejects an authority_ingested whose carried approval event is tampered", () => {
    const tampered = { ...grant, expires_at: "2026-10-18T00:00:00Z" };
    expect(validatePromotionEvent(ingest(tampered as ApprovalEvent)).join()).toMatch(
      /event_id_mismatch/,
    );
  });
});

describe("promotion fold: legal paths", () => {
  it("normal / unknown-response / break_glass paths fold without problems", () => {
    expect(
      problemsOf([ingest(grant), authorized(grant), send(), requested("777"), completed("777")]),
    ).toEqual([]);
    expect(problemsOf([ingest(grant), authorized(grant), send(), abandoned()])).toEqual([]);
    expect(
      problemsOf([ingest(grant), authorized(grant), send(), requested(null), abandoned()]),
    ).toEqual([]);
    expect(
      problemsOf([
        ingest(grant),
        authorized(grant),
        send(),
        requested(null),
        completed("9", PID(), "reconcile"),
      ]),
    ).toEqual([]);

    const bg = makeApproval({
      kind: "break_glass_approve",
      subject: SUBJECT,
      recorded_after_side_effect: true,
    });
    const external = {
      deployment_id: "555",
      sha: HEAD_SHA,
      environment: "github-pages" as const,
      created_at: AT,
      observed_state: "success",
    };
    expect(
      problemsOf([
        ingest(bg),
        authorized(bg, PID(), { external_effect: external }),
        completed("555"),
      ]),
    ).toEqual([]);
  });
});

describe("promotion fold: forbidden transitions", () => {
  const bg = makeApproval({
    kind: "break_glass_approve",
    subject: SUBJECT,
    recorded_after_side_effect: true,
  });
  const external = {
    deployment_id: "555",
    sha: HEAD_SHA,
    environment: "github-pages" as const,
    created_at: AT,
    observed_state: "success",
  };
  const cases: Array<[string, PromotionEvent[], RegExp]> = [
    ["authorized without ingest", [authorized(grant)], /approval_not_ingested/],
    ["effect_send without authorized", [ingest(grant), send()], /effect_send_without_authorized/],
    [
      "terminal right after authorized",
      [ingest(grant), authorized(grant), completed("1")],
      /terminal_without_effect_send/,
    ],
    [
      "abandoned without effect_send",
      [ingest(grant), authorized(grant), abandoned()],
      /terminal_without_effect_send/,
    ],
    [
      "abandoned with a known deployment",
      [ingest(grant), authorized(grant), send(), requested("7"), abandoned()],
      /abandon_with_known_deployment/,
    ],
    [
      "terminal on another deployment",
      [ingest(grant), authorized(grant), send(), requested("7"), completed("8")],
      /terminal_deployment_id_mismatch/,
    ],
    [
      "provider_poll terminal without a known id",
      [ingest(grant), authorized(grant), send(), requested(null), completed("8")],
      /requires_reconcile/,
    ],
    [
      "second effect_send",
      [ingest(grant), authorized(grant), send(), send()],
      /duplicate_event_id|effect_send_from_sent/,
    ],
    [
      "effect_requested before effect_send",
      [ingest(grant), authorized(grant), requested("7")],
      /effect_requested_from_authorized/,
    ],
    [
      "second terminal",
      [ingest(grant), authorized(grant), send(), abandoned(), completed("1", PID(), "reconcile")],
      /already_terminal/,
    ],
    [
      "send on break_glass external",
      [ingest(bg), authorized(bg, PID(), { external_effect: external }), send()],
      /break_glass_external/,
    ],
    [
      "break_glass terminal on other deployment",
      [ingest(bg), authorized(bg, PID(), { external_effect: external }), completed("556")],
      /break_glass_terminal_mismatch/,
    ],
    [
      "break_glass external sha mismatch",
      [
        ingest(bg),
        authorized(bg, PID(), { external_effect: { ...external, sha: "b".repeat(40) } }),
      ],
      /external_effect_sha_mismatch/,
    ],
    [
      "expiry window not respected",
      [ingest(grant), authorized(grant, PID(), { evaluated_at: "2026-10-16T23:45:00Z" })],
      /expiry_window_violated/,
    ],
    [
      "subject drift",
      [
        ingest(grant),
        authorized(grant, PID(), { subject: { ...SUBJECT, bundle_digest: SHA("9") } }),
      ],
      /subject_mismatch/,
    ],
    [
      "authority ingested twice",
      [ingest(grant), ingest(grant, OTHER)],
      /authority_already_ingested/,
    ],
  ];
  for (const [name, events, re] of cases) {
    it(name, () => {
      expect(problemsOf(events).join("\n")).toMatch(re);
    });
  }
});

describe("promotion fold: consumption, revoke, lock", () => {
  it("approval_event_id is consumed once across the whole ledger (other target included)", () => {
    const sameTarget = problemsOf([
      ingest(grant),
      authorized(grant),
      send(),
      abandoned(),
      authorized(grant, PID(2)),
    ]);
    expect(sameTarget.join()).toMatch(/approval_already_consumed/);

    const otherTarget = foldPromotionLedger([
      ingest(grant),
      authorized(grant),
      ingest(grant2, OTHER),
      authorized(grant, PID(1, "3003"), {}, OTHER),
    ]);
    expect(otherTarget.problems.join()).toMatch(/approval_already_consumed/);
  });

  it("revoke ingested before consume blocks it; after consume it is classified, outcome unchanged", () => {
    const revoke = makeApproval({
      kind: "approval_revoked",
      subject: SUBJECT,
      occurred_at: "2026-10-16T05:00:00Z",
      revoked_approval_event_id: grant.event_id,
    });
    expect(problemsOf([ingest(grant), ingest(revoke), authorized(grant)]).join()).toMatch(
      /approval_revoked_before_consume/,
    );

    const after = [
      ingest(grant),
      authorized(grant),
      ingest(revoke),
      ev({
        kind: "revoked_after_consume",
        promotion_id: PID(),
        approval_event_id: grant.event_id,
        revoke_event_id: revoke.event_id,
      }),
      send(),
      requested("7"),
      completed("7"),
    ];
    const fold = foldPromotionLedger(after);
    expect(fold.problems).toEqual([]);
    const p = fold.targets.get("acme/site#github-pages")?.promotions.get("1001:1");
    expect(p?.revokedAfterConsume).toHaveLength(1);
    expect(p?.terminal?.outcome).toBe("completed");
  });

  it("lock = open promotion OR unresolved late effect; another run_attempt is locked meanwhile", () => {
    const open = foldPromotionLedger([ingest(grant), authorized(grant)]);
    expect(open.targets.get("acme/site#github-pages")?.lockReasons).toEqual([
      "open_promotion:1001:1",
    ]);
    expect(
      problemsOf([
        ingest(grant),
        ingest(grant2),
        authorized(grant),
        authorized(grant2, PID(2)),
      ]).join(),
    ).toMatch(/target_locked: open_promotion:1001:1/);

    const detected = ev({
      kind: "late_effect_detected",
      deployment_id: "900",
      matched_promotion_id: PID(),
      provider_evidence: {
        sha: HEAD_SHA,
        environment: "github-pages",
        created_at: AT,
        observed_state: "success",
      },
    });
    const late = foldPromotionLedger([
      ingest(grant),
      authorized(grant),
      send(),
      abandoned(),
      detected,
    ]);
    const state = late.targets.get("acme/site#github-pages");
    expect(late.problems).toEqual([]);
    expect(state?.locked).toBe(true);
    expect(state?.lockReasons[0]).toMatch(/^pending_late_effect:/);

    const resolved = ev({
      kind: "late_effect_resolved",
      late_effect_event_id: detected.event_id,
      deployment_id: "900",
      resolution: "external_unattributed",
      attributed_promotion_id: null,
      human_confirmation: HUMAN,
      provider_evidence: {
        sha: HEAD_SHA,
        environment: "github-pages",
        created_at: AT,
        observed_state: "success",
      },
    });
    const done = foldPromotionLedger([
      ingest(grant),
      authorized(grant),
      send(),
      abandoned(),
      detected,
      resolved,
    ]);
    expect(done.problems).toEqual([]);
    expect(done.targets.get("acme/site#github-pages")?.locked).toBe(false);
  });
});

describe("artifact attribution in the fold", () => {
  type Mutable = Record<string, Record<string, Record<string, Record<string, unknown>>>>;

  it("evidence_artifact of another attempt is a fold problem", () => {
    const auth = structuredClone(authorized(grant)) as unknown as Mutable;
    (auth.resolved?.source_artifact?.evidence_artifact as Record<string, unknown>).name =
      "release-evidence-out-1001-2";
    const problems = problemsOf([ingest(grant), auth as unknown as PromotionEvent]);
    expect(problems.join("\n")).toMatch(/evidence_artifact_name_mismatch/);
  });

  it("promotion id attribution: exactly one of receipt / derived, and it must match", () => {
    const pid = { run_id: "1001", run_attempt: 1 };
    const derived = { ...pid, derived_from: "artifact_name" };
    for (const [rid, did, re] of [
      [null, null, /promotion_id_attribution/],
      [pid, derived, /promotion_id_attribution/],
      [{ run_id: "1001", run_attempt: 2 }, null, /receipt_promotion_id_mismatch/],
      [null, { ...derived, run_attempt: 2 }, /derived_promotion_id_mismatch/],
    ] as const) {
      const auth = structuredClone(authorized(grant)) as unknown as {
        resolved: Record<string, unknown>;
      };
      auth.resolved.receipt_promotion_id = rid;
      auth.resolved.derived_promotion_id = did;
      expect(validatePromotionEvent(auth)).toEqual([]);
      const problems = problemsOf([ingest(grant), auth as unknown as PromotionEvent]);
      expect(problems.join("\n")).toMatch(re);
    }
    const receiptOnly = structuredClone(authorized(grant)) as unknown as {
      resolved: Record<string, unknown>;
    };
    receiptOnly.resolved.receipt_promotion_id = pid;
    receiptOnly.resolved.derived_promotion_id = null;
    expect(problemsOf([ingest(grant), receiptOnly as unknown as PromotionEvent])).toEqual([]);
  });

  it("evidence_artifact.archive_digest is required and never null", () => {
    const auth = structuredClone(authorized(grant)) as unknown as Mutable;
    (auth.resolved?.source_artifact?.evidence_artifact as Record<string, unknown>).archive_digest =
      null;
    expect(validatePromotionEvent(auth)).not.toEqual([]);
    const { derived_promotion_id: _d, ...withoutDerived } = (
      authorized(grant) as unknown as { resolved: Record<string, unknown> }
    ).resolved;
    expect(validatePromotionEvent({ ...authorized(grant), resolved: withoutDerived })).not.toEqual(
      [],
    );
  });

  it("pages artifact of another executor attempt is a fold problem; name is required", () => {
    const other = structuredClone(send()) as unknown as Mutable;
    (other.pages_artifact as unknown as Record<string, unknown>).name = "github-pages-2002-2";
    const problems = problemsOf([
      ingest(grant),
      authorized(grant),
      other as unknown as PromotionEvent,
    ]);
    expect(problems.join("\n")).toMatch(/pages_artifact_name_mismatch/);

    const sent = send() as unknown as { pages_artifact: Record<string, unknown> };
    const { name: _name, ...pagesWithoutName } = sent.pages_artifact;
    expect(validatePromotionEvent({ ...sent, pages_artifact: pagesWithoutName })).not.toEqual([]);
  });
});
