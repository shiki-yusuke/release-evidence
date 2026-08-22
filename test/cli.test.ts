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
