// D13 retrospective dry-run (docs/retrospective/d13-2026-08-window/README.md): checks the
// checked-in releases.json, re-runs scripts/retrospective-d13-preflight.mjs against the harvester's
// metrics-data ref, and pins the abstain path to the existing SYNTHETIC replay packs under
// test/fixtures/replay-packs/ (never to a real release).
//
// RELEASE_EVIDENCE_HARVESTER_DIR must point at a local agent-metrics-harvester clone whose
// origin/metrics-data ref is fetched. Tests that read it are skipped with an explicit message
// when it is not set -- the same convention as RELEASE_EVIDENCE_CONTRACTS_DIR (helpers.ts).

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { ShadowEvaluation } from "../src/shadow/input.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETRO_ROOT = path.join(REPO_ROOT, "docs", "retrospective");
const WINDOW_DIR = path.join(RETRO_ROOT, "d13-2026-08-window");
const RELEASES_JSON = path.join(WINDOW_DIR, "releases.json");
const SCRIPT = path.join(REPO_ROOT, "scripts", "retrospective-d13-preflight.mjs");
const SHADOW_CLI = path.join(REPO_ROOT, "dist", "src", "shadow-cli", "main.js");
const SYNTHETIC_PACKS_DIR = path.join(REPO_ROOT, "test", "fixtures", "replay-packs");

const HARVESTER_DIR = process.env.RELEASE_EVIDENCE_HARVESTER_DIR;
const HAS_HARVESTER_DIR = Boolean(HARVESTER_DIR);
if (!HAS_HARVESTER_DIR) {
  console.warn(
    "RELEASE_EVIDENCE_HARVESTER_DIR is not set -- D13 retrospective preflight tests that read the harvester's metrics-data ref will be skipped. " +
      "Set it to a local agent-metrics-harvester clone (origin/metrics-data fetched) to run them.",
  );
}

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

const REASON_CODES = [
  "bundle_absent",
  "selection_manifest_absent",
  "policy_snapshot_absent",
  "effective_risk_unrecorded",
  "contract_pin_unrecorded",
];

interface RetroRelease {
  index: number;
  release_id: string;
  repo: string;
  ref: { tag: string | null; commit: string };
  ledger: { events: number };
  bundle: { present: boolean; path: string | null; digest: string | null };
  selection_manifest: { present: boolean };
  policy_snapshot: { present: boolean };
  preflight: { status: string; reasons: string[]; receipt: string };
  verification: { method: string; ref: string; commit: string };
}

interface RetroDoc {
  schema_version: string;
  enums: Record<string, string[]>;
  releases: RetroRelease[];
}

const doc = JSON.parse(readFileSync(RELEASES_JSON, "utf-8")) as RetroDoc;

function runScript(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8", env });
}

function listDirsRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? [full, ...listDirsRecursive(full)] : [];
  });
}

describe("D13 retrospective: releases.json (a)", () => {
  it("is d13-retrospective/v0 with exactly the 11 D13-window releases, indexed 1..11", () => {
    expect(doc.schema_version).toBe("d13-retrospective/v0");
    expect(doc.releases).toHaveLength(11);
    expect(doc.releases.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(doc.releases.map((r) => r.release_id)).toEqual(D13_RELEASE_IDS);
    expect(doc.enums["preflight.status"]).toEqual(["evaluable", "not_evaluable"]);
    expect(doc.enums["preflight.reasons"]).toEqual(REASON_CODES);
  });

  it.each(doc.releases)("#$index $release_id follows the schema", (r) => {
    expect(Object.keys(r).sort()).toEqual(
      [
        "index",
        "release_id",
        "repo",
        "ref",
        "ledger",
        "bundle",
        "selection_manifest",
        "policy_snapshot",
        "preflight",
        "verification",
      ].sort(),
    );
    expect(r.repo).toMatch(/^shiki-yusuke\/[a-z-]+$/);
    expect(r.ref.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(Number.isInteger(r.ledger.events) && r.ledger.events >= 0).toBe(true);
    if (r.bundle.present) {
      expect(r.bundle.path).toMatch(/^release-evidence\/bundles\/bundle-[0-9a-f]+\.json$/);
      expect(r.bundle.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    } else {
      expect(r.bundle).toEqual({ present: false, path: null, digest: null });
    }
    expect(r.selection_manifest).toEqual({ present: false });
    expect(r.policy_snapshot).toEqual({ present: false });
    expect(doc.enums["preflight.status"]).toContain(r.preflight.status);
    expect(r.preflight.status).toBe("not_evaluable");
    expect(r.preflight.receipt).toBe("no_receipt_emitted");
    for (const reason of r.preflight.reasons) expect(REASON_CODES).toContain(reason);
    const expectedReasons = r.bundle.present
      ? REASON_CODES.filter((c) => c !== "bundle_absent")
      : REASON_CODES;
    expect(r.preflight.reasons).toEqual(expectedReasons);
    expect(r.verification.method).toBe("harvester_ledger_and_bundles");
    expect(r.verification.ref).toBe("origin/metrics-data");
    expect(r.verification.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records no value the real records do not have (no effective_risk / policy / manifest digest)", () => {
    const raw = readFileSync(RELEASES_JSON, "utf-8");
    for (const key of [
      "effective_risk",
      "selection_manifest_digest",
      "policy_digest",
      "playbook_commit",
    ]) {
      expect(raw).not.toContain(`"${key}"`);
    }
  });
});

describe("D13 retrospective: conditional constraint (c)", () => {
  it("no not_evaluable release has a replay pack under docs/retrospective/**/replay-packs/, and each has no receipt", () => {
    const packDirs = listDirsRecursive(RETRO_ROOT).filter(
      (d) => path.basename(d) === "replay-packs",
    );
    const packNames = new Set(packDirs.flatMap((d) => readdirSync(d)));
    for (const r of doc.releases.filter((x) => x.preflight.status === "not_evaluable")) {
      const candidates = [r.release_id, r.release_id.replace(/[@/]/g, "-"), String(r.index)];
      for (const name of candidates) expect(packNames.has(name), name).toBe(false);
      expect(r.preflight.receipt).toBe("no_receipt_emitted");
    }
  });
});

describe("D13 retrospective: preflight script never involves the evaluator (d, static)", () => {
  const source = readFileSync(SCRIPT, "utf-8");

  it("imports only node: builtins and the vendored JCS helper", () => {
    const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map(
      (m) => m[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) {
      expect(
        s?.startsWith("node:") || s === "../vendor/playbook-shared/jcs.mjs",
        `unexpected import ${s}`,
      ).toBe(true);
    }
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  it("never names the evaluator (no 'shadow' anywhere in the source) and spawns only git", () => {
    expect(source.toLowerCase()).not.toContain("shadow");
    expect(source).not.toMatch(/\b(spawn|spawnSync|exec|execSync|fork|execFile)\s*\(/);
    const execFileCalls = [...source.matchAll(/execFileSync\(\s*([^,\s]+)/g)].map((m) => m[1]);
    expect(execFileCalls).toEqual(['"git"']);
    expect(source).not.toContain("process.env");
    // The only child_process import is the bare, un-aliased execFileSync, and there is exactly
    // one call site, so no alias or second spawn path can slip in.
    const cpImports = [
      ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g),
    ].map((m) => (m[1] ?? "").trim());
    expect(cpImports).toEqual(["execFileSync"]);
    expect(source).not.toMatch(/from\s*"child_process"/);
    expect(source.match(/execFileSync\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\bas\s+\w+\s*\}/);
  });

  it("pins the eleven D13 release IDs in the source (not read back from releases.json)", () => {
    for (const id of D13_RELEASE_IDS) expect(source).toContain(`"${id}"`);
  });
});

describe("D13 retrospective: preflight script error handling (e)", () => {
  it("exits 2 when --harvester is not given", () => {
    const res = runScript(["--releases", RELEASES_JSON]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--harvester");
    expect(res.stdout).toBe("");
  });

  it("exits 2 when releases.json does not list exactly the eleven D13 releases (swapped ID)", () => {
    const swapped = JSON.parse(readFileSync(RELEASES_JSON, "utf-8")) as RetroDoc;
    (swapped.releases[2] as RetroRelease).release_id = "spec-lane@9.9.9";
    const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-retro-swapped-"));
    const file = path.join(dir, "releases.json");
    writeFileSync(file, JSON.stringify(swapped));
    const res = runScript(["--harvester", tmpdir(), "--releases", file]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("not the D13 window document");
    expect(res.stdout).toBe("");
  });

  it("exits 2 when --harvester does not exist", () => {
    const missing = path.join(tmpdir(), "release-evidence-no-such-harvester-dir");
    const res = runScript(["--harvester", missing, "--releases", RELEASES_JSON]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("not readable");
    expect(res.stdout).toBe("");
  });

  it("exits 2 when --harvester is a directory but not a git repository with the ref", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "release-evidence-empty-harvester-"));
    const res = runScript(["--harvester", empty, "--releases", RELEASES_JSON]);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe.skipIf(!HAS_HARVESTER_DIR)(
  "D13 retrospective: preflight against the harvester (b, d)",
  () => {
    const harvester = HARVESTER_DIR as string;

    it("(b) exits 0 with no diffs, 11 not_evaluable, and the commit recorded in releases.json", () => {
      const res = runScript(["--harvester", harvester, "--releases", RELEASES_JSON]);
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      const out = JSON.parse(res.stdout);
      expect(out.diffs).toEqual([]);
      expect(out.evaluator_invoked).toBe(false);
      expect(out.summary).toEqual({ releases: 11, not_evaluable: 11, evaluable: 0 });
      expect(out.input_record_hits).toEqual({ keys: [], paths: [] });
      for (const r of doc.releases) expect(r.verification.commit).toBe(out.harvester.commit);
      const byId = new Map(
        out.releases.map((r: { release_id: string }) => [r.release_id, r] as const),
      );
      for (const r of doc.releases) {
        const got = byId.get(r.release_id) as { preflight: unknown; ledger: unknown };
        expect(got.preflight).toEqual(r.preflight);
        expect(got.ledger).toEqual(r.ledger);
      }
    });

    it("(b) reports a diff and exits 1 when releases.json disagrees with the recomputation", () => {
      const tampered = JSON.parse(readFileSync(RELEASES_JSON, "utf-8")) as RetroDoc;
      const last = tampered.releases[10] as RetroRelease;
      last.ledger.events = 0;
      last.preflight.reasons = REASON_CODES;
      const dir = mkdtempSync(path.join(tmpdir(), "release-evidence-retro-tampered-"));
      const file = path.join(dir, "releases.json");
      writeFileSync(file, JSON.stringify(tampered));
      const res = runScript(["--harvester", harvester, "--releases", file]);
      expect(res.status).toBe(1);
      const out = JSON.parse(res.stdout);
      expect(out.diffs.join("\n")).toContain("ledger.events");
      expect(out.diffs.join("\n")).toContain("preflight.reasons");
    });

    it("(b) an unrelated record carrying an input key fails the run as unattributed and flips no status", () => {
      // Clone the harvester, add one commit on top of metrics-data that records `effective_risk`
      // under a release_id outside the window, and point the script at that commit.
      const clone = mkdtempSync(path.join(tmpdir(), "release-evidence-retro-unrelated-"));
      const g = (...a: string[]) =>
        execFileSync("git", ["-C", clone, ...a], { encoding: "utf-8", stdio: "pipe" });
      execFileSync("git", ["clone", "-q", "--no-checkout", harvester, clone], { stdio: "pipe" });
      const base = execFileSync("git", ["-C", harvester, "rev-parse", "origin/metrics-data"], {
        encoding: "utf-8",
      }).trim();
      g("fetch", "-q", "origin", base);
      g("checkout", "-q", "-b", "unrelated", base);
      writeFileSync(
        path.join(clone, "release-evidence", "other.json"),
        JSON.stringify({
          release_id: "someone-else@1.0.0",
          effective_risk: "low",
          policy_digest: "sha256:0",
        }),
      );
      g(
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "user.name=t",
        "add",
        "release-evidence/other.json",
      );
      g(
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "unrelated record",
      );
      const res = runScript([
        "--harvester",
        clone,
        "--releases",
        RELEASES_JSON,
        "--ref",
        "unrelated",
      ]);
      expect(res.status).toBe(1);
      const out = JSON.parse(res.stdout);
      expect(out.summary).toEqual({ releases: 11, not_evaluable: 11, evaluable: 0 });
      expect(out.diffs.some((d: string) => d.startsWith("unattributed key effective_risk"))).toBe(
        true,
      );
      // The only other diffs are the verification commit (expected: different ref/commit).
      for (const d of out.diffs) expect(d).toMatch(/^unattributed key|: verification: /);
    });

    it("(d) succeeds with a PATH that holds only git (no evaluator binary, no override)", () => {
      const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
      expect(path.isAbsolute(git)).toBe(true);
      const onlyGit = mkdtempSync(path.join(tmpdir(), "release-evidence-retro-only-git-"));
      symlinkSync(git, path.join(onlyGit, "git"));
      const res = runScript(["--harvester", harvester, "--releases", RELEASES_JSON], {
        PATH: onlyGit,
        HOME: process.env.HOME,
      });
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout).diffs).toEqual([]);
    });
  },
);

describe("D13 retrospective: abstain path is shown on SYNTHETIC fixtures only (f)", () => {
  // Existing synthetic packs (docs/replay-pack-format.md "Sample packs"); no real release.
  const packs = ["lane-ref-omitted", "lane-backed"];

  beforeAll(() => {
    execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
  });

  it.each(packs)("synthetic pack %s replays to its expected.json (verdict abstained)", (name) => {
    const dir = path.join(SYNTHETIC_PACKS_DIR, name);
    const outDir = mkdtempSync(path.join(tmpdir(), "release-evidence-retro-abstain-"));
    const outPath = path.join(outDir, "out.json");
    execFileSync(
      process.execPath,
      [SHADOW_CLI, "replay", "--input", path.join(dir, "input.json"), "--out", outPath],
      { encoding: "utf-8" },
    );
    const evaluation = JSON.parse(readFileSync(outPath, "utf-8")) as ShadowEvaluation;
    const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf-8")) as {
      evaluation_status: string;
      verdict: string | null;
      predicate_observations: { predicate_id: string; status: string; reason_code?: string }[];
    };
    expect(expected.verdict).toBe("abstained");
    expect(evaluation.evaluation_status).toBe(expected.evaluation_status);
    expect(evaluation.candidate_receipt?.verdict ?? null).toBe(expected.verdict);
    const byId = new Map(evaluation.predicate_observations.map((o) => [o.predicate_id, o]));
    for (const exp of expected.predicate_observations) {
      const actual = byId.get(
        exp.predicate_id as (typeof evaluation.predicate_observations)[number]["predicate_id"],
      );
      expect(actual?.status).toBe(exp.status);
      if (exp.reason_code) expect(actual?.reason?.code).toBe(exp.reason_code);
    }
  });

  it("the D13 window's real releases are not among the synthetic packs", () => {
    const names = readdirSync(SYNTHETIC_PACKS_DIR);
    for (const r of doc.releases) expect(names).not.toContain(r.release_id);
  });
});
