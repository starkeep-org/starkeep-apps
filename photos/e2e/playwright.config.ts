import { defineConfig, devices } from "@playwright/test";

/**
 * App-functionality e2e for photos (platform test plan case 7b). One platform
 * stack is booted in global-setup and shared by every spec; flows mutate the
 * installed app's state, so everything runs serially in one worker.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
});
