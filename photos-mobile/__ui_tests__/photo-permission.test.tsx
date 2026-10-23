/**
 * The photo permission, as `useForegroundWork` asks for it.
 *
 * The decisions are `nextAccessStep`'s and have their own tests in
 * `device-library.test.ts`. These pin the wiring around them: that the first
 * open asks once, that a return to the foreground re-reads without asking, that
 * a blocked permission goes to system settings, and that a grant starts the
 * catch-up that imports the camera roll.
 */
import { act, renderHook } from "@testing-library/react-native";
import { AppState, Linking, type AppStateStatus } from "react-native";
import { deviceMedia, mediaLocationGranted } from "../src/platform";
import type { MediaPermission } from "../src/media/device-library";
import { useForegroundWork } from "../src/ui/use-foreground-work";
import type { LibraryState, NodeState, StorageState } from "../src/ui/use-library";

jest.mock("../src/platform", () => ({
  deviceMedia: {
    getPermissions: jest.fn(),
    requestPermissions: jest.fn(),
    onChange: jest.fn(() => ({ remove: jest.fn() })),
  },
  mediaLocationGranted: jest.fn(() => true),
}));

jest.mock("../src/work/background-task", () => ({
  registerBackgroundWork: jest.fn(async () => undefined),
  readRealDeviceState: jest.fn(async () => ({
    hasNetwork: true,
    isUnmetered: true,
    isCharging: false,
    isStorageLow: false,
  })),
}));

const GRANTED: MediaPermission = { granted: true, canAskAgain: true };
const DENIED: MediaPermission = { granted: false, canAskAgain: true };
const BLOCKED: MediaPermission = { granted: false, canAskAgain: false };

const getPermissions = deviceMedia.getPermissions as jest.Mock;
const requestPermissions = deviceMedia.requestPermissions as jest.Mock;

/** A node with no cloud, so a catch-up imports and never syncs. */
const READY = {
  status: "ready",
  node: { engine: null, uploads: null },
  identity: {},
  clock: {},
  connection: null,
} as unknown as NodeState;
const STARTING: NodeState = { status: "starting" };

function libraryStub() {
  return {
    reload: jest.fn(async () => undefined),
    importQuietly: jest.fn(async () => undefined),
    backfillDurations: jest.fn(async () => true),
    backfillExif: jest.fn(async () => true),
    backfillThumbHashes: jest.fn(async () => true),
    backfillPosters: jest.fn(async () => true),
    deriveRenditions: jest.fn(async () => true),
    sweepNullModified: jest.fn(async () => undefined),
  } as unknown as LibraryState & { importQuietly: jest.Mock };
}

const storage = { refresh: jest.fn() } as unknown as StorageState;

/** Every `AppState` change listener the hook has registered and not removed. */
async function appStateTo(state: AppStateStatus) {
  const listeners = (AppState.addEventListener as jest.Mock).mock.calls
    .filter(([event]) => event === "change")
    .map(([, listener]) => listener as (next: AppStateStatus) => void);
  await act(async () => {
    for (const listener of listeners) listener(state);
  });
}

/** Lets the hook's chained awaits run out. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

function renderWork(node: NodeState, library = libraryStub()) {
  const hook = renderHook(
    ({ node: current }: { node: NodeState }) => useForegroundWork(current, library, storage),
    { initialProps: { node } },
  );
  return { ...hook, library };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("the media-location permission", () => {
  const locationGranted = mediaLocationGranted as jest.Mock;
  afterEach(() => locationGranted.mockReturnValue(true));

  // A phone that granted photo access before the app declared location access
  // was never asked for it, and every import since lost its GPS.
  it("asks once when photos are granted and location is not", async () => {
    getPermissions.mockResolvedValue(GRANTED);
    requestPermissions.mockResolvedValue(GRANTED);
    locationGranted.mockReturnValue(false);
    renderWork(READY);
    await settle();
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it("does not ask when location is already granted", async () => {
    getPermissions.mockResolvedValue(GRANTED);
    renderWork(READY);
    await settle();
    expect(requestPermissions).not.toHaveBeenCalled();
  });
});

describe("the photo permission", () => {
  it("asks once when the node opens, not when the screen mounts", async () => {
    getPermissions.mockResolvedValue(DENIED);
    requestPermissions.mockResolvedValue(DENIED);
    const { rerender } = renderWork(STARTING);
    await settle();
    expect(requestPermissions).not.toHaveBeenCalled();

    rerender({ node: READY });
    await settle();
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it("re-reads on a return to the foreground without asking again", async () => {
    getPermissions.mockResolvedValue(DENIED);
    requestPermissions.mockResolvedValue(DENIED);
    const { result } = renderWork(READY);
    await settle();
    expect(requestPermissions).toHaveBeenCalledTimes(1);

    // Granted in system settings while the app was away.
    getPermissions.mockResolvedValue(GRANTED);
    await appStateTo("background");
    await appStateTo("active");
    await settle();

    expect(requestPermissions).toHaveBeenCalledTimes(1);
    expect(result.current.mediaAccess).toBe("granted");
  });

  it("does not ask on open when Android will no longer show the dialog", async () => {
    getPermissions.mockResolvedValue(BLOCKED);
    const { result } = renderWork(READY);
    await settle();
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(Linking.openSettings).not.toHaveBeenCalled();
    expect(result.current.mediaAccess).toBe("blocked");
  });

  it("opens system settings from the prompt once access is blocked", async () => {
    getPermissions.mockResolvedValue(BLOCKED);
    const { result } = renderWork(READY);
    await settle();

    await act(() => result.current.requestMediaAccess());
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it("starts a catch-up when the prompt's ask is granted", async () => {
    getPermissions.mockResolvedValue(DENIED);
    requestPermissions.mockResolvedValue(DENIED);
    const { result, library } = renderWork(READY);
    await settle();
    expect(library.importQuietly).not.toHaveBeenCalled();

    getPermissions.mockResolvedValue(GRANTED);
    requestPermissions.mockResolvedValue(GRANTED);
    await act(() => result.current.requestMediaAccess());
    await settle();

    expect(requestPermissions).toHaveBeenCalledTimes(2);
    expect(result.current.mediaAccess).toBe("granted");
    expect(library.importQuietly).toHaveBeenCalledTimes(1);
  });
});
