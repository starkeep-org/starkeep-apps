/**
 * The way back to the camera roll above the grid, after a person refused it.
 *
 * Without the prompt a refusal would be final, because nothing else in the app
 * asks again. Its words follow `mediaAccess`: "Allow access" while Android will
 * still show the dialog, "Open settings" once it will not. `useForegroundWork`
 * decides what a tap does, and `photo-permission.test.tsx` covers that.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { MediaAccess } from "../src/media/device-library";
import { HomeScreen } from "../src/ui/HomeScreen";
import type { ForegroundWork } from "../src/ui/use-foreground-work";

jest.mock("../src/platform", () => ({}));
jest.mock("../src/auth/session", () => ({ onSessionRejected: () => () => undefined }));

jest.mock("../src/ui/use-library", () => {
  const library = {
    items: [],
    loading: false,
    loaded: true,
    loadingMore: false,
    hasMore: false,
    loadMoreError: null,
    error: null,
    reload: async () => undefined,
    loadMore: async () => undefined,
  };
  return {
    useNode: () => ({ state: { status: "starting" }, reopen: async () => undefined }),
    useLibrary: () => library,
    useStorage: () => ({ report: null, error: null, refresh: () => undefined, ceilings: null }),
  };
});

// Named `mock…` so the hoisted factory below may read it.
let mockWork: ForegroundWork;
jest.mock("../src/ui/use-foreground-work", () => ({ useForegroundWork: () => mockWork }));

function workWith(mediaAccess: MediaAccess | null): ForegroundWork {
  return {
    syncing: false,
    syncError: null,
    uploads: null,
    syncNow: jest.fn(),
    catchUpNow: jest.fn(async () => undefined),
    mediaAccess,
    requestMediaAccess: jest.fn(async () => undefined),
    importGate: "open",
    importWithoutPull: jest.fn(),
  };
}

describe("the grid's access prompt", () => {
  it("offers the system dialog while Android will still show it", () => {
    mockWork = workWith("denied");
    render(<HomeScreen onConnect={jest.fn()} />);
    expect(screen.queryByText("Open settings")).toBeNull();

    fireEvent.press(screen.getByText("Allow access"));
    expect(mockWork.requestMediaAccess).toHaveBeenCalledTimes(1);
  });

  it("offers system settings once Android will no longer ask", () => {
    mockWork = workWith("blocked");
    render(<HomeScreen onConnect={jest.fn()} />);
    expect(screen.queryByText("Allow access")).toBeNull();

    fireEvent.press(screen.getByText("Open settings"));
    expect(mockWork.requestMediaAccess).toHaveBeenCalledTimes(1);
  });

  it("is absent with access, and before the permission has been read", () => {
    for (const access of ["granted", "limited", null] as const) {
      mockWork = workWith(access);
      const { unmount } = render(<HomeScreen onConnect={jest.fn()} />);
      expect(screen.queryByText("Allow access")).toBeNull();
      expect(screen.queryByText("Open settings")).toBeNull();
      unmount();
    }
  });
});
