/**
 * Mocks every component test needs and `jest-expo` does not provide.
 *
 * The local native modules under `modules/` need nothing here: each one loads
 * through `requireOptionalNativeModule`, which answers null under `jest-expo`,
 * and the app already treats a missing module as a binary built without it.
 */

// Zero insets and a real provider, from the package's own mock.
jest.mock("react-native-safe-area-context", () =>
  jest.requireActual("react-native-safe-area-context/jest/mock").default,
);

// `expo-video` reaches its native player class at import, which `jest-expo`
// does not mock. No component test plays a clip; a test that needs to can
// replace these.
jest.mock("expo-video", () => ({
  useVideoPlayer: jest.fn(() => ({
    playing: false,
    play: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  })),
  VideoView: () => null,
}));

// The icon font loads asynchronously and re-renders every icon when it lands,
// outside any test's `act`. An icon that draws nothing is all a test needs.
jest.mock("@expo/vector-icons", () => ({ MaterialIcons: () => null }));

// The handset timing log, which says nothing in a test.
jest.mock("../src/ui/perf", () => ({ perf: () => undefined }));
