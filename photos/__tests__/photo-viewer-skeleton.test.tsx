// @vitest-environment jsdom
/**
 * Full-size viewer loading state. The list is fetched with ?include=metadata,
 * so records carry real width/height — the loader box is proportioned from those
 * dimensions (not a fixed rectangle, and no thumbnail-measurement hack). While
 * the full-size original downloads the viewer shows a plain gray pulse skeleton
 * that shares the exact same box as the image, then cross-fades the image in.
 * The viewer never renders a bare <img> with an absent/unloaded src, which would
 * flash the browser's broken-image glyph. When dimensions are absent (metadata
 * not yet backfilled) it falls back to a fixed-height box.
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

describe("PhotoViewer proportioning from record dimensions", () => {
  it("shapes the loader box to the record's real aspect ratio — no thumbnail measurement", () => {
    // Portrait 600x800 → ratio 0.75, taken straight from width/height.
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    renderViewer(appImage({ width: 600, height: 800 }), getSrc);

    const wrapper = screen.getByTestId("photo-skeleton").parentElement as HTMLElement;
    // CSS normalizes the numeric ratio to "<n> / 1".
    expect(wrapper.style.aspectRatio).toMatch(/^0\.75\b/);
  });

  it("is a plain gray pulse div (never a blurred thumbnail image)", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    renderViewer(appImage({ width: 800, height: 600 }), getSrc);

    const skeleton = screen.getByTestId("photo-skeleton");
    expect(skeleton.tagName).toBe("DIV");
    expect(skeleton.style.animation).toContain("starkeep-skeleton-pulse");
    // No blur-up: the loader carries no image src and no blur filter.
    expect(skeleton.getAttribute("src")).toBeNull();
    expect(skeleton.style.filter).toBe("");

    const wrapper = skeleton.parentElement as HTMLElement;
    expect(wrapper.style.aspectRatio).toMatch(/^1\.3333/);
  });
});

describe("PhotoViewer skeleton → image cross-fade", () => {
  // The skeleton is aria-hidden, so getByRole("img") returns only the real
  // full-size image.
  const skeleton = () => screen.getByTestId("photo-skeleton");
  const fullImg = () => screen.getByRole("img") as HTMLImageElement;

  it("shows the gray skeleton with the full image faded out over it while downloading", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    renderViewer(appImage(), getSrc);

    expect(skeleton()).toBeTruthy();
    // Full image is mounted (downloading) but transparent until it loads.
    expect(fullImg().src).toBe("https://signed/full");
    expect(fullImg().style.opacity).toBe("0");
  });

  it("cross-fades the full image in and removes the skeleton once it loads", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    renderViewer(appImage(), getSrc);

    act(() => fireEvent.load(fullImg()));

    expect(fullImg().style.opacity).toBe("1");
    expect(screen.queryByTestId("photo-skeleton")).toBeNull();
  });

  it("resets to the faded-out state when the resolved src changes (opening a different photo)", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/a");
    const { rerender } = renderViewer(appImage({ id: "orig-a" }), getSrc);
    act(() => fireEvent.load(fullImg()));
    expect(fullImg().style.opacity).toBe("1");

    getSrc.mockReturnValue("https://signed/b");
    rerender(
      <PhotoUrlProvider getThumbnailSrc={getSrc} getFullSizeSrc={getSrc}>
        <PhotoViewer image={appImage({ id: "orig-b" })} onClose={() => {}} />
      </PhotoUrlProvider>,
    );

    // New photo: full image transparent again until it loads, skeleton shown.
    expect(fullImg().src).toBe("https://signed/b");
    expect(fullImg().style.opacity).toBe("0");
    expect(screen.getByTestId("photo-skeleton")).toBeTruthy();
  });
});

describe("PhotoViewer without dimensions (metadata pending)", () => {
  const img = (c: HTMLElement) => c.querySelector("img") as HTMLImageElement | null;

  it("shows a fixed-height box and no <img> while the signed URL is still resolving", () => {
    const getSrc = vi.fn().mockReturnValue(null);
    const { container } = renderViewer(appImage({ width: 0, height: 0 }), getSrc);

    const skeleton = screen.getByTestId("photo-skeleton");
    expect(skeleton).toBeTruthy();
    // Box keeps a fixed height when there's no aspect ratio to shape it.
    const wrapper = skeleton.parentElement as HTMLElement;
    expect(wrapper.style.aspectRatio).toBe("");
    expect(wrapper.style.height).toContain("100vh");
    // No bare <img> with an absent src — that's what flashed the broken glyph.
    expect(img(container)).toBeNull();
  });

  it("keeps the <img> hidden behind the box until it finishes loading, then reveals it", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    const { container } = renderViewer(appImage({ width: 0, height: 0 }), getSrc);

    const el = img(container)!;
    expect(el.src).toBe("https://signed/full");
    expect(el.style.opacity).toBe("0");
    expect(screen.getByTestId("photo-skeleton")).toBeTruthy();

    act(() => fireEvent.load(el));
    expect(el.style.opacity).toBe("1");
    expect(screen.queryByTestId("photo-skeleton")).toBeNull();
  });
});
