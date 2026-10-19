import { defineConfig } from "vitest/config";

// Restrict to source tests only -- tsc -b's own output (dist/) mirrors test/**/*.test.ts as
// dist/test/**/*.test.js, and vitest's default include glob would otherwise pick both up and
// run every test twice.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // dist/ is built once here, before any test worker starts (see test/global-setup.ts for the
    // concurrent-build race this replaces).
    globalSetup: ["test/global-setup.ts"],
  },
});
