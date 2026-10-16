// @vitest-environment jsdom
/**
 * A video tile wears a play badge, so a clip is distinguishable from a photo
 * without opening it. The badge rides every video tile, whatever the tile is
 * painting, and never a still.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PhotoThumbnail } from "../src/photos-ui/components/grid/photo-thumbnail";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
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
    originalFilename: "clip.mov",
    effectiveDateTaken: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function renderTile(image: AppImage, box: { width?: number; height?: number } = {}) {
  return render(
    <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
      <PhotoThumbnail image={image} onSelect={() => {}} {...box} />
    </PhotoUrlProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the video play badge", () => {
  it("marks a video tile, even before any poster arrives", () => {
    renderTile(appImage({ mimeType: "video/quicktime" }));
    const badge = screen.getByTestId("video-play-badge");
    expect(badge.style.opacity).toBe("0.7");
    // The tile owns the click; the badge must not swallow it.
    expect(badge.style.pointerEvents).toBe("none");
  });

  it("leaves a still unmarked", () => {
    renderTile(appImage({ mimeType: "image/jpeg" }));
    expect(screen.queryByTestId("video-play-badge")).toBeNull();
  });

  it("scales with the tile, within bounds", () => {
    renderTile(appImage({ mimeType: "video/mp4" }), { width: 300, height: 120 });
    expect(screen.getByTestId("video-play-badge").getAttribute("width")).toBe("36");
    cleanup();
    renderTile(appImage({ mimeType: "video/mp4" }), { width: 60, height: 40 });
    expect(screen.getByTestId("video-play-badge").getAttribute("width")).toBe("24");
    cleanup();
    renderTile(appImage({ mimeType: "video/mp4" }), { width: 900, height: 600 });
    expect(screen.getByTestId("video-play-badge").getAttribute("width")).toBe("56");
  });
});
