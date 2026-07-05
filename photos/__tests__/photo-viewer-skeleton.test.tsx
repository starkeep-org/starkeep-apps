// @vitest-environment jsdom
/**
 * Full-size viewer loading state: when a photo is opened, its signed URL is a
 * guaranteed cache miss (the grid only prefetched thumbnail-record URLs, the
 * viewer resolves the original), so getFullSizeSrc first returns null and the
 * large original then has to download. PhotoViewer must show a skeleton across
 * both gaps and never render a bare <img> with an absent/unloaded src — that
 * would flash the browser's broken-image glyph.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { PhotoViewer } from "../src/photos-ui/components/viewer/photo-viewer";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import type { AppImage } from "../src/photos-lib";

function appImage(over: Partial<AppImage> = {}): AppImage {
  return {
    id: "orig-1",
    mimeType: "image/jpeg",
    objectStorageKey: "shared/image/aa/hash",
    sizeBytes: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parentId: null,
    width: 4000,
    height: 3000,
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
      orientation: null,
    },
    originalFilename: "photo.jpg",
    effectiveDateTaken: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function renderViewer(image: AppImage, getFullSizeSrc: (id: string) => string | null) {
  return render(
    <PhotoUrlProvider getThumbnailSrc={getFullSizeSrc} getFullSizeSrc={getFullSizeSrc}>
      <PhotoViewer image={image} onClose={() => {}} />
    </PhotoUrlProvider>,
  );
}

beforeEach(() => {
  // The info panel (hidden by default) never fetches on mount, but stub fetch
  // defensively so nothing hits the network if that ever changes.
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({ image: null }) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PhotoViewer loading skeleton", () => {
  // The <img> is display:none until loaded, so it's absent from the a11y tree
  // and getByRole("img") can't see it — query the DOM directly.
  const img = (c: HTMLElement) => c.querySelector("img") as HTMLImageElement | null;

  it("shows the skeleton and no <img> while the signed URL is still resolving", () => {
    const getSrc = vi.fn().mockReturnValue(null);
    const { container } = renderViewer(appImage(), getSrc);

    expect(getSrc).toHaveBeenCalledWith("orig-1");
    expect(screen.getByTestId("photo-skeleton")).toBeTruthy();
    // No bare <img> with an absent src — that's what flashed the broken glyph.
    expect(img(container)).toBeNull();
  });

  it("keeps the <img> hidden behind the skeleton until it finishes loading", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    const { container } = renderViewer(appImage(), getSrc);

    const el = img(container)!;
    expect(el.src).toBe("https://signed/full");
    // Present in the DOM (so the browser downloads it) but not yet visible.
    expect(el.style.display).toBe("none");
    expect(screen.getByTestId("photo-skeleton")).toBeTruthy();
  });

  it("reveals the image and drops the skeleton once onLoad fires", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    const { container } = renderViewer(appImage(), getSrc);

    const el = img(container)!;
    act(() => fireEvent.load(el));

    expect(el.style.display).toBe("block");
    expect(screen.queryByTestId("photo-skeleton")).toBeNull();
  });

  it("re-shows the skeleton when the resolved src changes (opening a different photo)", () => {
    // First render resolves to a real URL and loads.
    const getSrc = vi.fn().mockReturnValue("https://signed/a");
    const { container, rerender } = renderViewer(appImage({ id: "orig-a" }), getSrc);
    act(() => fireEvent.load(img(container)!));
    expect(screen.queryByTestId("photo-skeleton")).toBeNull();

    // A new photo resolves to a different URL — skeleton must return until that
    // image loads, rather than showing the previous (stale) frame as "loaded".
    getSrc.mockReturnValue("https://signed/b");
    rerender(
      <PhotoUrlProvider getThumbnailSrc={getSrc} getFullSizeSrc={getSrc}>
        <PhotoViewer image={appImage({ id: "orig-b" })} onClose={() => {}} />
      </PhotoUrlProvider>,
    );

    const el = img(container)!;
    expect(el.src).toBe("https://signed/b");
    expect(el.style.display).toBe("none");
    expect(screen.getByTestId("photo-skeleton")).toBeTruthy();
  });
});
