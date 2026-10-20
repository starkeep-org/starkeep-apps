/**
 * Jest, for component and hook tests only. Logic tests run on Vitest; see
 * `vitest.config.ts` for where the line between them falls.
 *
 * No path into `starkeep-core` belongs here. Core comes from npm, and a test
 * that needs the linked mode `metro.config.js` describes is a test that only
 * passes on one machine.
 */
module.exports = {
  // Android, as the app ships: `Platform.OS` and the Android-only modules
  // answer as they do on a handset.
  preset: "jest-expo/android",
  testMatch: ["<rootDir>/__ui_tests__/**/*.test.tsx"],
  setupFiles: ["<rootDir>/__ui_tests__/setup.ts"],
};
