// @vitest-environment jsdom
/**
 * Selecting photos in the grid: a checkbox on hover with a mouse, a long press
 * on touch, and a click that toggles rather than opens while a selection is
 * under way. A tile outside any selection opens on click as it always did.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PhotoThumbnail } from "../src/photos-ui/components/grid/photo-thumbnail";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import { SelectionProvider, useSelection } from "../src/photos-ui/context/selection-context";
import { LONG_PRESS_MS } from "../src/photos-ui/hooks/use-long-press";
import type { AppImage } from "../src/photos-lib";

class FakeIntersectionObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function appImage(over: Partial<AppImage> = {}): AppImage {
  return {
    id: "rec-1",
    mimeType: "image/jpeg",
    objectStorageKey: "shared/image/aa/hash",
    sizeBytes: 8 * 1024 * 1024,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parentId: null,
    derivedKind: null,
    variants: {},
    thumbHash: null,
    width: 1920,
    height: 1080,
    exif: {
      capturedAt: null,
      cameraMake: null,
      cameraModel: null,
      fNumber: null,
      exposureTime: null,
      iso: null,
      lensModel: null,
      gpsLat: null,
      gpsLon: null,
      present: null,
      orientation: null,
    },
    originalFilename: "beach.jpg",
    effectiveDateTaken: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}


let selected: string[] = [];
function Spy() {
  const selection = useSelection();
  selected = selection ? [...selection.selection.ids].sort() : [];
  return null;
}

function renderGrid(ids: string[], onSelect: (id: string) => void, withSelection = true) {
  const tiles = ids.map((id) => (
    <PhotoThumbnail key={id} image={appImage({ id, originalFilename: id })} onSelect={onSelect} />
  ));
  return render(
    <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
      {withSelection ? (
        <SelectionProvider order={ids}>
          {tiles}
          <Spy />
        </SelectionProvider>
      ) : (
        tiles
      )}
    </PhotoUrlProvider>,
  );
}

const tile = (id: string) => document.querySelector(`[data-record-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  selected = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("selecting in the grid", () => {
  it("shows a checkbox on mouse hover only", () => {
    renderGrid(["a"], () => {});
    expect(screen.queryByTestId("tile-select")).toBeNull();
    fireEvent.pointerEnter(tile("a"), { pointerType: "touch" });
    expect(screen.queryByTestId("tile-select")).toBeNull();
    fireEvent.pointerEnter(tile("a"), { pointerType: "mouse" });
    expect(screen.getByTestId("tile-select")).toBeTruthy();
  });

  it("starts a selection from the checkbox, then toggles on click instead of opening", () => {
    const onSelect = vi.fn();
    renderGrid(["a", "b"], onSelect);
    fireEvent.pointerEnter(tile("a"), { pointerType: "mouse" });
    fireEvent.click(screen.getByTestId("tile-select"));
    expect(selected).toEqual(["a"]);
    expect(onSelect).not.toHaveBeenCalled();
    // Every tile offers its checkbox once a selection is under way.
    expect(screen.getAllByTestId("tile-select")).toHaveLength(2);
    fireEvent.click(tile("b"));
    expect(selected).toEqual(["a", "b"]);
    fireEvent.click(tile("a"));
    expect(selected).toEqual(["b"]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("extends a run with shift-click", () => {
    renderGrid(["a", "b", "c", "d"], () => {});
    fireEvent.pointerEnter(tile("a"), { pointerType: "mouse" });
    fireEvent.click(screen.getByTestId("tile-select"));
    fireEvent.click(tile("c"), { shiftKey: true });
    expect(selected).toEqual(["a", "b", "c"]);
  });

  it("starts a selection on a long touch, and the release does not open the photo", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    renderGrid(["a"], onSelect);
    fireEvent.pointerDown(tile("a"), { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(selected).toEqual(["a"]);
    fireEvent.pointerUp(tile("a"), { pointerType: "touch" });
    fireEvent.click(tile("a"));
    expect(selected).toEqual(["a"]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reads a touch that moves as a scroll, not a press", () => {
    vi.useFakeTimers();
    renderGrid(["a"], () => {});
    fireEvent.pointerDown(tile("a"), { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile("a"), { pointerType: "touch", clientX: 10, clientY: 40 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(selected).toEqual([]);
  });

  it("opens on click, with no checkbox, outside any selection", () => {
    const onSelect = vi.fn();
    renderGrid(["a"], onSelect, false);
    fireEvent.pointerEnter(tile("a"), { pointerType: "mouse" });
    expect(screen.queryByTestId("tile-select")).toBeNull();
    fireEvent.click(tile("a"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});
