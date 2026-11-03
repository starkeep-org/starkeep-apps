/**
 * The first-run screen: a fresh library asks to sign in before its first
 * import, and offers "Import without signing in" behind a confirmation.
 *
 * `import-gate.test.ts` covers the decision, and `photo-permission.test.tsx`
 * covers what the escape hatch starts. These pin what the screen shows for
 * each gate and where each tap goes.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Alert } from "react-native";
import type { ImportGate } from "../src/media/import-gate";
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

function workWith(importGate: ImportGate | null, syncing = false): ForegroundWork {
  return {
    syncing,
    syncError: null,
    uploads: null,
    syncNow: jest.fn(),
    catchUpNow: jest.fn(async () => undefined),
    mediaAccess: null,
    requestMediaAccess: jest.fn(async () => undefined),
    importGate,
    importWithoutPull: jest.fn(),
  };
}

afterEach(() => jest.restoreAllMocks());

describe("a fresh library with no session", () => {
  it("offers sign-in in place of the grid", () => {
    mockWork = workWith("sign-in");
    const onConnect = jest.fn();
    render(<HomeScreen onConnect={onConnect} />);
    expect(screen.queryByText("No photos yet.")).toBeNull();

    fireEvent.press(screen.getByText("Sign in to Starkeep Cloud"));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("imports without signing in only after the person confirms", () => {
    mockWork = workWith("sign-in");
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    render(<HomeScreen onConnect={jest.fn()} />);

    fireEvent.press(screen.getByText("Import without signing in"));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(mockWork.importWithoutPull).not.toHaveBeenCalled();

    const buttons = alert.mock.calls[0]![2]!;
    buttons.find((button) => button.text === "Import")!.onPress!();
    expect(mockWork.importWithoutPull).toHaveBeenCalledTimes(1);
  });

  it("imports nothing when the person cancels", () => {
    mockWork = workWith("sign-in");
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    render(<HomeScreen onConnect={jest.fn()} />);

    fireEvent.press(screen.getByText("Import without signing in"));
    const cancel = alert.mock.calls[0]![2]!.find((button) => button.text === "Cancel")!;
    expect(cancel.style).toBe("cancel");
    expect(cancel.onPress).toBeUndefined();
    expect(mockWork.importWithoutPull).not.toHaveBeenCalled();
  });
});

describe("a signed-in library waiting for its first pull", () => {
  it("shows the grid with a notice and a Sync now button", () => {
    mockWork = workWith("first-pull");
    render(<HomeScreen onConnect={jest.fn()} />);
    expect(screen.queryByText("Sign in to Starkeep Cloud")).toBeNull();
    expect(screen.getByText("The photos on this phone appear once your library arrives from the cloud.")).toBeTruthy();

    fireEvent.press(screen.getByText("Sync now"));
    expect(mockWork.syncNow).toHaveBeenCalledTimes(1);
  });

  it("imports without waiting only after the person confirms", () => {
    mockWork = workWith("first-pull");
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    render(<HomeScreen onConnect={jest.fn()} />);

    fireEvent.press(screen.getByText("Import without waiting"));
    expect(mockWork.importWithoutPull).not.toHaveBeenCalled();

    alert.mock.calls[0]![2]!.find((button) => button.text === "Import")!.onPress!();
    expect(mockWork.importWithoutPull).toHaveBeenCalledTimes(1);
  });

  it("says the sync is running while it runs", () => {
    mockWork = workWith("first-pull", true);
    render(<HomeScreen onConnect={jest.fn()} />);
    expect(
      screen.getByText("Syncing your library. The photos on this phone appear once your library arrives."),
    ).toBeTruthy();
    expect(screen.queryByText("Sync now")).toBeNull();
  });
});

describe("an open library", () => {
  it("shows the grid alone", () => {
    for (const gate of ["open", null] as const) {
      mockWork = workWith(gate);
      const { unmount } = render(<HomeScreen onConnect={jest.fn()} />);
      expect(screen.queryByText("Sign in to Starkeep Cloud")).toBeNull();
      expect(screen.queryByText("Sync now")).toBeNull();
      unmount();
    }
  });
});
