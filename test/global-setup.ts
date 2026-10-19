// vitest globalSetup: build dist/ exactly once per run.
//
// Seven test files spawn dist/src/cli/*.js (or import dist/src/core/*.js from a worker) and
// used to run `pnpm run build` (tsc -b) in their own beforeAll. With files running in parallel,
// one file's tsc rewrote dist/ while another file's subprocess was loading it, so the CLI exited
// 1 mid-write and an exit-code assertion failed by chance (playbook consumer-conformance
// 2026-10-16 and 2026-10-19, test/cli.test.ts). Building once, before any worker starts,
// removes the writer/reader race; the build itself is not under test.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default function setup(): void {
  execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
}
