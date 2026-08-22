// CLI-level negative injection: two illegal scenarios must be REJECTED by the actual `release-
// evidence` binary (process exit code, not just an internal function returning problems[]).
// Runs the built dist/src/cli/main.js as a real subprocess so the assertions cover the exit
// code contract the CLI promises (record: exit 3 and no write; audit: exit 1 and a reported
// reason).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTRACTS_DIR, HAS_CONTRACTS_DIR } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "cli", "main.js");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, RELEASE_EVIDENCE_CONTRACTS_DIR: CONTRACTS_DIR },
      encoding: "utf-8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

describe.skipIf(!HAS_CONTRACTS_DIR)("release-evidence CLI negative injection", () => {
  beforeAll(() => {
    // Guarantee dist/ reflects the current source before spawning it as a subprocess.
    execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  });

  it("`record` rejects an illegal transition with exit 3 and writes nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-cli-record-"));
    const ledgerPath = path.join(dir, "release-events.jsonl");
    const bundlePath = path.join(
      CONTRACTS_DIR ?? "",
      "fixtures",
      "accept-bundle-spec-lane-0-6-0.json",
    );

    const prepareResult = runCli(["prepare", "--bundle", bundlePath, "--ledger", ledgerPath]);
    expect(prepareResult.status).toBe(0);
    const { bundle_digest: bundleDigest } = JSON.parse(prepareResult.stdout) as {
      bundle_digest: string;
    };

    const ledgerAfterPrepare = readFileSync(ledgerPath, "utf-8");

    // Illegal: jumping straight to `verified|preview` from `prepared` skips the `deployed`
    // step the graph requires.
    const illegal = runCli([
      "record",
      "verified",
      "--ledger",
      ledgerPath,
      "--release-id",
      "spec-lane@0.6.0",
      "--bundle-digest",
      bundleDigest,
      "--environment",
      "preview",
    ]);

    expect(illegal.status).toBe(3);
    expect(illegal.stderr).toMatch(/illegal transition/);
    expect(readFileSync(ledgerPath, "utf-8")).toBe(ledgerAfterPrepare); // nothing was written

    rmSync(dir, { recursive: true, force: true });
  });

  it("`record deployed --environment production` requires --bundle: exit 2 without it, exit 3 when the gate rejects it", () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(CONTRACTS_DIR ?? "", "fixtures", "accept-collection-lane-backed-happy.json"),
        "utf-8",
      ),
    ) as { bundles: Array<{ release_id: string; lane_ref: unknown }> };
    const laneBackedBundle = fixture.bundles[0];
    if (!laneBackedBundle) throw new Error("fixture has no bundles");

    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-cli-prod-gate-"));
    const ledgerPath = path.join(dir, "release-events.jsonl");
    const bundlePath = path.join(dir, "bundle.json");
    writeFileSync(bundlePath, JSON.stringify(laneBackedBundle));

    const prepareResult = runCli(["prepare", "--bundle", bundlePath, "--ledger", ledgerPath]);
    expect(prepareResult.status).toBe(0);
    const { bundle_digest: bundleDigest } = JSON.parse(prepareResult.stdout) as {
      bundle_digest: string;
    };
    const releaseId = laneBackedBundle.release_id;

    const commonRecordArgs = [
      "--ledger",
      ledgerPath,
      "--release-id",
      releaseId,
      "--bundle-digest",
      bundleDigest,
    ];
    expect(
      runCli(["record", "deployed", ...commonRecordArgs, "--environment", "preview"]).status,
    ).toBe(0);
    expect(
      runCli(["record", "verified", ...commonRecordArgs, "--environment", "preview"]).status,
    ).toBe(0);

    const ledgerBeforeProduction = readFileSync(ledgerPath, "utf-8");

    // Missing --bundle on a production deploy is a usage error (exit 2), not a silently
    // unverified gate.
    const withoutBundle = runCli([
      "record",
      "deployed",
      ...commonRecordArgs,
      "--environment",
      "production",
      "--staging-skipped",
    ]);
    expect(withoutBundle.status).toBe(2);
    expect(readFileSync(ledgerPath, "utf-8")).toBe(ledgerBeforeProduction); // nothing written

    // With --bundle supplied but no prior lane_done_overlay attestation recorded, the
    // production gate itself must reject: exit 3, still nothing written.
    const withBundleNoAttestation = runCli([
      "record",
      "deployed",
      ...commonRecordArgs,
      "--environment",
      "production",
      "--staging-skipped",
      "--bundle",
      bundlePath,
    ]);
    expect(withBundleNoAttestation.status).toBe(3);
    expect(withBundleNoAttestation.stderr).toMatch(/production_gate_missing_done_attestation/);
    expect(readFileSync(ledgerPath, "utf-8")).toBe(ledgerBeforeProduction); // nothing written

    rmSync(dir, { recursive: true, force: true });
  });

  it("`status` refuses to fold a ledger containing a schema-invalid line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-cli-status-invalid-"));
    const ledgerPath = path.join(dir, "release-events.jsonl");
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        schema_version: "release-evidence/v0",
        event_id: "bad-1",
        release_id: "demo@1.0.0",
        kind: "unknown", // not a member of the schema's closed enum
        environment: null,
        occurred_at: "2026-08-22T00:00:00Z",
        actor: "cli",
        bundle_digest: `sha256:${"a".repeat(64)}`,
      })}\n`,
    );

    const result = runCli(["status", "--ledger", ledgerPath]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/contract-violating/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("`status --release-id` filters the reported attempts without breaking rollback resolution", () => {
    const events = JSON.parse(
      readFileSync(
        path.join(CONTRACTS_DIR ?? "", "fixtures", "accept-events-rollback.json"),
        "utf-8",
      ),
    ) as Array<{ release_id: string }>;

    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-cli-status-filter-"));
    const ledgerPath = path.join(dir, "release-events.jsonl");
    writeFileSync(ledgerPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    // demo@1.1.0's rolled_back event points back to demo@1.0.0, which only reached production
    // in an EARLIER, different attempt -- filtering the report down to demo@1.1.0 must not
    // cause that resolution check to lose sight of demo@1.0.0's events.
    const filtered = runCli(["status", "--ledger", ledgerPath, "--release-id", "demo@1.1.0"]);

    expect(filtered.status).toBe(0);
    const body = JSON.parse(filtered.stdout) as {
      attempts: Array<{ release_id: string }>;
      ledger_problems: string[];
    };
    expect(body.ledger_problems).toEqual([]);
    expect(body.attempts.every((a) => a.release_id === "demo@1.1.0")).toBe(true);
    expect(body.attempts.length).toBeGreaterThan(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("`audit` fails a collection whose event carries a bundle_digest that resolves to no real bundle", () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(CONTRACTS_DIR ?? "", "fixtures", "reject-collection-fake-bundle-digest.json"),
        "utf-8",
      ),
    ) as { bundles: Array<{ release_id: string }>; events: unknown[] };

    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-cli-audit-"));
    const bundlesDir = path.join(dir, "bundles");
    mkdirSync(bundlesDir);
    fixture.bundles.forEach((bundle, i) => {
      writeFileSync(
        path.join(bundlesDir, `${i}-${bundle.release_id.replace(/[^a-z0-9.]+/gi, "_")}.json`),
        JSON.stringify(bundle),
      );
    });
    const ledgerPath = path.join(dir, "release-events.jsonl");
    writeFileSync(ledgerPath, `${fixture.events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const result = runCli(["audit", "--ledger", ledgerPath, "--bundles", bundlesDir]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/bundle_digest_unresolved/);

    rmSync(dir, { recursive: true, force: true });
  });
});

// Argument-parsing checks don't touch schema validation, so they don't need
// RELEASE_EVIDENCE_CONTRACTS_DIR -- this describe block runs unconditionally.
describe("release-evidence CLI argument allowlist", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  });

  it("rejects an unrecognized flag (typo) with exit 2", () => {
    const result = runCli(["status", "--ledger", "/dev/null", "--relese-id", "x"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown flag --relese-id/);
  });

  it("rejects an extra positional argument with exit 2", () => {
    const result = runCli(["record", "deployed", "EXTRA", "--ledger", "/dev/null"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/too many positional arguments/);
  });

  it("rejects a duplicated flag with exit 2", () => {
    const result = runCli(["status", "--ledger", "/dev/null", "--ledger", "/dev/null"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/given more than once/);
  });

  it("rejects an unknown command even with --help, rather than treating --help as a bypass", () => {
    const result = runCli(["unknown", "--help"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown command "unknown"/);
  });

  it("still honors --help for a known command (exit 0)", () => {
    const result = runCli(["status", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/release-evidence status/);
  });
});
