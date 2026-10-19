// release-evidence is a promotion authority consumer. The playbook's cognitive-ack/v0 contract
// (a human's self-reported acknowledgement, authority: none) must never become an input to
// authorization here: no source, contract vendoring, or workflow may mention it. This is the
// consumer-side half of that contract's "no veto / no gate" rule.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["src", "contracts", "scripts", ".github"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("no dependency on cognitive-ack/v0 (authority: none must stay outside authorization)", () => {
  it("no file under src/, contracts/, scripts/ or .github/ mentions cognitive-ack", () => {
    const hits: string[] = [];
    for (const top of SCANNED) {
      const dir = path.join(ROOT, top);
      let files: string[] = [];
      try {
        files = walk(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (/cognitive[-_]ack/i.test(readFileSync(f, "utf-8"))) hits.push(path.relative(ROOT, f));
      }
    }
    expect(hits).toEqual([]);
  });

  it("the scan itself sees a planted mention (self-test of the pattern)", () => {
    expect(/cognitive[-_]ack/i.test("imports cognitive-ack/v0")).toBe(true);
  });
});
