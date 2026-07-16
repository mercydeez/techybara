import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests spawn real git processes in temp repos; the 5s default flakes on
    // slow windows-latest CI runners. Per-test overrides still win where set.
    testTimeout: 30000,
  },
});
