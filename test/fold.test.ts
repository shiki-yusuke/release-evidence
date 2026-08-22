import { describe, expect, it } from "vitest";
import { foldAttempt, foldLedger } from "../src/core/fold.js";
import type { ReleaseEvent } from "../src/core/types.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function ev(
  partial: Partial<ReleaseEvent> & Pick<ReleaseEvent, "event_id" | "kind">,
): ReleaseEvent {
  return {
    schema_version: "release-evidence/v0",
    release_id: "demo@1.0.0",
    environment: null,
    occurred_at: "2026-08-22T00:00:00Z",
    actor: "cli",
    bundle_digest: DIGEST,
    ...partial,
  };
}

describe("foldAttempt", () => {
  it("folds the full happy path to production_verified with staging skipped", () => {
    const events = [
      ev({ event_id: "1", kind: "prepared", environment: null }),
      ev({ event_id: "2", kind: "deployed", environment: "preview" }),
      ev({ event_id: "3", kind: "verified", environment: "preview" }),
      ev({ event_id: "4", kind: "deployed", environment: "production", staging_skipped: true }),
      ev({ event_id: "5", kind: "verified", environment: "production" }),
    ];
    const result = foldAttempt("demo@1.0.0", DIGEST, events);
    expect(result.state).toBe("production_verified");
    expect(result.reachedProduction).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("folds through staging when not skipped", () => {
    const events = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({ event_id: "2", kind: "deployed", environment: "preview" }),
      ev({ event_id: "3", kind: "verified", environment: "preview" }),
      ev({ event_id: "4", kind: "deployed", environment: "staging" }),
      ev({ event_id: "5", kind: "verified", environment: "staging" }),
      ev({ event_id: "6", kind: "deployed", environment: "production" }),
    ];
    const result = foldAttempt("demo@1.0.0", DIGEST, events);
    expect(result.state).toBe("production_deployed");
    expect(result.problems).toEqual([]);
  });

  it("rejects a direct production deploy before any preview (illegal_transition)", () => {
    const events = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({ event_id: "2", kind: "deployed", environment: "production" }),
    ];
    const result = foldAttempt("demo@1.0.0", DIGEST, events);
    expect(result.problems[0]).toMatch(/^illegal_transition:/);
  });

  it("requires staging_skipped: true on a direct preview_verified -> production jump", () => {
    const events = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({ event_id: "2", kind: "deployed", environment: "preview" }),
      ev({ event_id: "3", kind: "verified", environment: "preview" }),
      ev({ event_id: "4", kind: "deployed", environment: "production" }), // no staging_skipped
    ];
    const result = foldAttempt("demo@1.0.0", DIGEST, events);
    expect(result.problems[0]).toMatch(/^staging_skip_unrecorded:/);
  });

  it("forbids staging_skipped: true when staging actually happened", () => {
    const events = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({ event_id: "2", kind: "deployed", environment: "preview" }),
      ev({ event_id: "3", kind: "verified", environment: "preview" }),
      ev({ event_id: "4", kind: "deployed", environment: "staging" }),
      ev({ event_id: "5", kind: "verified", environment: "staging" }),
      ev({ event_id: "6", kind: "deployed", environment: "production", staging_skipped: true }),
    ];
    const result = foldAttempt("demo@1.0.0", DIGEST, events);
    expect(result.problems[0]).toMatch(/^staging_skip_misrecorded:/);
  });

  it("checks failure_phase against the state the attempt was actually in", () => {
    const events = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({ event_id: "2", kind: "deployed", environment: "preview" }),
      ev({ event_id: "3", kind: "verified", environment: "preview" }),
      ev({ event_id: "4", kind: "deployed", environment: "production", staging_skipped: true }),
      ev({
        event_id: "5",
        kind: "failed",
        environment: "production",
        failure_phase: "deploy", // wrong: a deploy that already succeeded fails verification, not deploy
        reason: "smoke test failed",
      }),
    ];
    const result = foldAttempt("demo@1.0.0", DIGEST, events);
    expect(result.problems[0]).toMatch(/^failure_phase_mismatch:/);
  });

  it("allows failed -> rolled_back only for an attempt that reached production", () => {
    const reachedProd = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({ event_id: "2", kind: "deployed", environment: "preview" }),
      ev({ event_id: "3", kind: "verified", environment: "preview" }),
      ev({ event_id: "4", kind: "deployed", environment: "production", staging_skipped: true }),
      ev({
        event_id: "5",
        kind: "failed",
        environment: "production",
        failure_phase: "verification",
        reason: "500s",
      }),
      ev({
        event_id: "6",
        kind: "rolled_back",
        environment: "production",
        rollback_to_release_id: "demo@0.9.0",
        reason: "withdrawn",
      }),
    ];
    expect(foldAttempt("demo@1.0.0", DIGEST, reachedProd).problems).toEqual([]);
    expect(foldAttempt("demo@1.0.0", DIGEST, reachedProd).state).toBe("rolled_back");

    const neverReachedProd = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({
        event_id: "2",
        kind: "failed",
        environment: "preview",
        failure_phase: "deploy",
        reason: "boom",
      }),
      ev({
        event_id: "3",
        kind: "rolled_back",
        environment: "production",
        rollback_to_release_id: "demo@0.9.0",
        reason: "withdrawn",
      }),
    ];
    expect(foldAttempt("demo@1.0.0", DIGEST, neverReachedProd).problems[0]).toMatch(
      /^illegal_transition:/,
    );
  });

  it("treats attested as state-preserving, and rejects it before prepared", () => {
    const legal = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({ event_id: "2", kind: "deployed", environment: "preview" }),
      ev({
        event_id: "3",
        kind: "attested",
        attestation: { kind: "lane_done_overlay", digest: OTHER_DIGEST },
      }),
      ev({ event_id: "4", kind: "verified", environment: "preview" }),
    ];
    const result = foldAttempt("demo@1.0.0", DIGEST, legal);
    expect(result.state).toBe("preview_verified");
    expect(result.problems).toEqual([]);

    const beforePrepared = [
      ev({
        event_id: "1",
        kind: "attested",
        attestation: { kind: "lane_done_overlay", digest: OTHER_DIGEST },
      }),
    ];
    expect(foldAttempt("demo@1.0.0", DIGEST, beforePrepared).problems[0]).toMatch(
      /^illegal_transition:/,
    );
  });
});

describe("foldLedger", () => {
  it("detects a duplicate event_id across the ledger", () => {
    const events = [
      ev({ event_id: "dup", kind: "prepared" }),
      ev({ event_id: "dup", kind: "deployed", environment: "preview" }),
    ];
    const { problems } = foldLedger(events);
    expect(problems.some((p) => p.startsWith('duplicate_event_id: "dup"'))).toBe(true);
  });

  it("rejects a rollback that targets its own release_id", () => {
    const events = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({
        event_id: "2",
        kind: "rolled_back",
        environment: "production",
        rollback_to_release_id: "demo@1.0.0",
        reason: "self-reference",
      }),
    ];
    const { problems } = foldLedger(events);
    expect(problems.some((p) => p.startsWith("rollback_to_self:"))).toBe(true);
  });

  it("rejects a rollback whose target never reached production earlier in the ledger", () => {
    const events = [
      ev({ event_id: "1", kind: "prepared" }),
      ev({ event_id: "2", kind: "deployed", environment: "preview" }),
      ev({ event_id: "3", kind: "verified", environment: "preview" }),
      ev({ event_id: "4", kind: "deployed", environment: "production", staging_skipped: true }),
      ev({
        event_id: "5",
        kind: "rolled_back",
        environment: "production",
        rollback_to_release_id: "demo@0.9.0", // never appears as having reached production
        reason: "regression",
      }),
    ];
    const { problems } = foldLedger(events);
    expect(problems.some((p) => p.startsWith("dangling_rollback_reference:"))).toBe(true);
  });

  it("folds independent attempts (different bundle_digest) separately", () => {
    const events = [
      ev({ event_id: "a1", kind: "prepared", bundle_digest: DIGEST }),
      ev({ event_id: "b1", kind: "prepared", bundle_digest: OTHER_DIGEST }),
      ev({ event_id: "a2", kind: "deployed", environment: "preview", bundle_digest: DIGEST }),
    ];
    const { attempts, problems } = foldLedger(events);
    expect(problems).toEqual([]);
    expect(attempts.get(`demo@1.0.0 ${DIGEST}`)?.state).toBe("preview_deployed");
    expect(attempts.get(`demo@1.0.0 ${OTHER_DIGEST}`)?.state).toBe("prepared");
  });
});
