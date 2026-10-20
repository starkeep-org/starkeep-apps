import { defineConfig } from "vitest/config";

/**
 * Vitest, for logic that runs in Node. Component and hook tests live in
 * `__ui_tests__/` and run on Jest under `jest-expo`, which renders React
 * Native; Vitest's default pattern would otherwise sweep their `.test.tsx`
 * files in and fail on every React Native import.
 */
export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
  },
});
