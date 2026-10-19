// `release-evidence promote <sub>` as a real subprocess: USAGE, flag allowlist, and the exit
// code contract for the paths reachable without a provider (0 / 1 / 2 / 3). Codes 4 / 5 / 6
// need an injected fetch or git race and are covered in-process by promotion-commands.test.ts.

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  forceRemoteCommit,
  git,
  makeSandbox,
  remoteLedger,
  sendFlags,
} from "./promotion-fixtures.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO_ROOT, "dist", "src", "cli", "main.js");
const SUBS = ["lock-status", "ingest", "authorize", "send", "finalize", "reconcile"];

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

const toArgs = (flags: Record<string, string | boolean>) =>
  Object.entries(flags).flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, String(v)]));

describe("release-evidence promote CLI", () => {
  const sb = makeSandbox();
  const common = { ...sb.common, "github-api": "https://api.invalid" };
  const { "github-api": _unused, ...lockFlags } = sb.common;
  afterAll(() => rmSync(sb.root, { recursive: true, force: true }));

  it("promote --help lists all six subcommands; each sub has its own --help", () => {
    const r = runCli(["promote", "--help"]);
    expect(r.status).toBe(0);
    for (const sub of SUBS) expect(r.stdout).toContain(`promote ${sub} `);
    const one = runCli(["promote", "send", "--help"]);
    expect(one.status).toBe(0);
    expect(one.stdout).toContain("--oidc-token-file");
  });

  it("usage errors exit 2", () => {
    expect(runCli(["promote"]).status).toBe(2);
    expect(runCli(["promote", "deploy"]).status).toBe(2);
    expect(runCli(["promote", "lock-status", "--bogus", "x"]).status).toBe(2);
    expect(runCli(["promote", "lock-status", "--ledger-repo", sb.ledger]).status).toBe(2);
    expect(runCli(["promote", "ingest", ...toArgs(common), "--run-id", "1"]).status).toBe(2);
  });

  it("lock-status exits 0 with JSON; ingest with nothing to ingest commits nothing", () => {
    const lock = runCli(["promote", "lock-status", ...toArgs(lockFlags)]);
    expect(lock.status).toBe(0);
    expect(JSON.parse(lock.stdout)).toMatchObject({ locked: false, reasons: [] });
    const ingest = runCli(["promote", "ingest", ...toArgs(common)]);
    expect(ingest.status, ingest.stderr).toBe(0);
    expect(JSON.parse(ingest.stdout)).toMatchObject({ committed: false });
    expect(remoteLedger(sb)).toEqual([]);
  });

  it("send without an authorized promotion exits 3 and writes nothing", () => {
    const r = runCli([
      "promote",
      "send",
      ...toArgs({ ...sendFlags(sb), "github-api": "https://api.invalid" }),
    ]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).error).toMatch(/no authorized promotion/);
    expect(r.stdout + r.stderr).not.toContain("SECRET-OIDC-TOKEN");
  });

  it("an invalid ledger exits 1 for writes and reads as locked", () => {
    forceRemoteCommit(sb, { "promotion-events.jsonl": "{broken\n" }, []);
    const head = git(sb.remote, ["rev-parse", "refs/heads/promotion-ledger"]);
    const ingest = runCli(["promote", "ingest", ...toArgs(common)]);
    expect(ingest.status, ingest.stderr).toBe(1);
    expect(git(sb.remote, ["rev-parse", "refs/heads/promotion-ledger"])).toBe(head);
    const lock = runCli(["promote", "lock-status", ...toArgs(lockFlags)]);
    expect(lock.status).toBe(0);
    expect(JSON.parse(lock.stdout)).toMatchObject({ locked: true, reasons: ["ledger_invalid"] });
  });
});
