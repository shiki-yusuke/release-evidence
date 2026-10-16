import { defineConfig } from "vitest/config";

// Restrict to source tests only -- tsc -b's own output (dist/) mirrors test/**/*.test.ts as
// dist/test/**/*.test.js, and vitest's default include glob would otherwise pick both up and
// run every test twice.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Several files run `pnpm run build` (tsc -b) in beforeAll, concurrently on a cold CI
    // runner; the 10 s default hook timeout fails them by chance (playbook conformance
    // 2026-10-16, three files). The build itself is not the thing under test.
    hookTimeout: 60_000,
  },
});
