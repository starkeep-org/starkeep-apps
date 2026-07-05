// @vitest-environment jsdom
/**
 * EXIF-orientation display regression tests.
 *
 * Bug: rotated originals (e.g. orientation 6 = "rotate 90° CW") rendered
 * sideways in a container of the inverted aspect ratio. Two compounding causes:
 *
 *  1. The viewer proportioned its box from the *stored* pixel dimensions
 *     (landscape for a portrait shot), giving an inverted-aspect box.
 *  2. Both the viewer and the thumbnail applied a manual `transform: rotate()`
 *     on top of the browser's own EXIF auto-orientation (image-orientation
 *     defaults to from-image) — a double rotation that spun the already-upright
 *     image sideways.
 *
 * The fix: never rotate via CSS transform (defer to the browser, made explicit
 * with image-orientation: from-image), and proportion the viewer box from the
 * *displayed* dimensions (width/height swapped for ±90° orientations 5–8).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { PhotoViewer } from "../src/photos-ui/components/viewer/photo-viewer";
import { PhotoThumbnail } from "../src/photos-ui/components/grid/photo-thumbnail";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import type { AppImage } from "../src/photos-lib";

// `orientation` is a convenience for the nested exif.orientation field, which
// is what every test here actually exercises.
function appImage(over: Partial<AppImage> & { orientation?: number | null } = {}): AppImage {
  const { orientation, exif, ...rest } = over;
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
      orientation: orientation ?? null,
      ...exif,
    },
    originalFilename: "photo.jpg",
    effectiveDateTaken: "2026-01-01T00:00:00.000Z",
    ...rest,
  };
}

function renderViewer(image: AppImage, getSrc: (id: string) => string | null) {
  return render(
    <PhotoUrlProvider getThumbnailSrc={getSrc} getFullSizeSrc={getSrc}>
      <PhotoViewer image={image} onClose={() => {}} />
    </PhotoUrlProvider>,
  );
}

// Deterministic IntersectionObserver so the thumbnail renders its <img>.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {}
  unobserve(): void {}
  intersect(isIntersecting: boolean): void {
    this.callback(
      this.observed.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

function renderThumbnail(image: AppImage, getSrc: (id: string) => string | null) {
  const result = render(
    <PhotoUrlProvider getThumbnailSrc={getSrc} getFullSizeSrc={getSrc}>
      <PhotoThumbnail image={image} onSelect={() => {}} />
    </PhotoUrlProvider>,
  );
  act(() => FakeIntersectionObserver.instances[0]!.intersect(true));
  return result;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({ image: null }) })));
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PhotoViewer EXIF orientation", () => {
  it("never applies a CSS rotate transform — the browser auto-orients via image-orientation", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    // orientation 6 = 90° CW; stored landscape 4000x3000.
    renderViewer(appImage({ orientation: 6 }), getSrc);

    const img = screen.getByRole("img") as HTMLImageElement;
    // The old bug applied transform: rotate(90deg) on top of the browser's
    // own rotation, spinning the image sideways.
    expect(img.style.transform).toBe("");
    expect(img.style.imageOrientation).toBe("from-image");
  });

  it("proportions the box from the DISPLAYED dimensions for a 90° CW original (6)", () => {
    // Stored 4000x3000 (landscape) but displayed as 3000x4000 portrait once
    // rotated → box ratio must be 3000/4000 = 0.75, not 1.333.
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    renderViewer(appImage({ width: 4000, height: 3000, orientation: 6 }), getSrc);

    const wrapper = screen.getByTestId("photo-skeleton").parentElement as HTMLElement;
    expect(wrapper.style.aspectRatio).toMatch(/^0\.75\b/);
  });

  it("swaps axes for 270° CW (8) as well", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    renderViewer(appImage({ width: 4000, height: 3000, orientation: 8 }), getSrc);

    const wrapper = screen.getByTestId("photo-skeleton").parentElement as HTMLElement;
    expect(wrapper.style.aspectRatio).toMatch(/^0\.75\b/);
  });

  it("does NOT swap axes for a 180° flip (3) — dimensions are unchanged", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    renderViewer(appImage({ width: 4000, height: 3000, orientation: 3 }), getSrc);

    const wrapper = screen.getByTestId("photo-skeleton").parentElement as HTMLElement;
    expect(wrapper.style.aspectRatio).toMatch(/^1\.3333/);
  });

  it("uses stored dimensions directly when there is no orientation", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/full");
    renderViewer(appImage({ width: 4000, height: 3000, orientation: null }), getSrc);

    const wrapper = screen.getByTestId("photo-skeleton").parentElement as HTMLElement;
    expect(wrapper.style.aspectRatio).toMatch(/^1\.3333/);
  });
});

describe("PhotoThumbnail EXIF orientation", () => {
  it("never applies a CSS rotate transform, and defers to browser orientation", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/t1");
    // Defensive: even if a thumbnail record carried a raw orientation, the
    // component must not double-apply it on top of the browser.
    renderThumbnail(appImage({ id: "thumb-1", parentId: "orig-1", orientation: 6 }), getSrc);

    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.style.transform).toBe("");
    expect(img.style.imageOrientation).toBe("from-image");
  });
});
