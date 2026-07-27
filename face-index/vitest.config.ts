import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // Boots a real local-data-server process per file.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
