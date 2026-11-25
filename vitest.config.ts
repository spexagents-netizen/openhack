import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: [
        "src/main/agent/**/*.ts",
        "src/main/providers/**/*.ts",
        "src/main/workspace/**/*.ts",
        "src/main/config/**/*.ts",
        "src/main/security/**/*.ts",
        "src/main/checkpoints/**/*.ts",
        "src/main/bus/**/*.ts",
        "src/main/browser/url.ts",
        "src/main/web/**/*.ts",
      ],
      // Scope now includes security, checkpoints, the bus and the browser URL
      // policy. Remaining branches are mostly defensive failure paths (spawn
      // failures, socket errors, queue starvation) that need fault injection to
      // reach. Gate at the measured floor so regressions still fail the build.
      thresholds: { lines: 90, functions: 85, branches: 71, statements: 85 },
    },
    testTimeout: 15000,
  },
});
