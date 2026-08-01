// @vitest-environment jsdom
/**
 * Lazy thumbnail loading: PhotoThumbnail must not ask for a signed URL until
 * the tile actually approaches the viewport (IntersectionObserver), so a
 * large gallery doesn't fan out into a URL request per photo on mount — the
 * burst that throttled the cloud data server's Lambda.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { PhotoThumbnail } from "../src/photos-ui/components/grid/photo-thumbnail";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import type { AppImage } from "../src/photos-lib";

// Deterministic IntersectionObserver stand-in: tests trigger intersection
// explicitly via intersect().
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.observed.push(el);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  unobserve(): void {}

  intersect(isIntersecting: boolean): void {
    this.callback(
      this.observed.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

function appImage(over: Partial<AppImage> = {}): AppImage {
  return {
    id: "thumb-1",
    mimeType: "image/jpeg",
    objectStorageKey: "shared/image/aa/hash",
    sizeBytes: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parentId: "orig-1",
    derivedKind: "thumbnail",
    variants: {},
    thumbHash: null,
    width: 400,
    height: 300,
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

function renderThumbnail(image: AppImage, getFullSizeSrc: (id: string) => string | null) {
  return render(
    <PhotoUrlProvider getThumbnailSrc={getFullSizeSrc} getFullSizeSrc={getFullSizeSrc}>
      <PhotoThumbnail image={image} onSelect={() => {}} />
    </PhotoUrlProvider>,
  );
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PhotoThumbnail lazy loading", () => {
  it("does not request a URL before the tile intersects the viewport", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/t1");
    renderThumbnail(appImage(), getSrc);

    expect(getSrc).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    expect(FakeIntersectionObserver.instances[0]!.observed).toHaveLength(1);
  });

  it("requests the URL and renders the image once intersecting, then stops observing", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/t1");
    renderThumbnail(appImage(), getSrc);

    const observer = FakeIntersectionObserver.instances[0]!;
    act(() => observer.intersect(true));

    expect(getSrc).toHaveBeenCalledWith("thumb-1");
    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.src).toBe("https://signed/t1");
    expect(observer.disconnected).toBe(true);
  });

  it("stays a placeholder on a non-intersecting notification", () => {
    const getSrc = vi.fn();
    renderThumbnail(appImage(), getSrc);

    act(() => FakeIntersectionObserver.instances[0]!.intersect(false));
    expect(getSrc).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders the placeholder while the URL is still resolving (null src)", () => {
    const getSrc = vi.fn().mockReturnValue(null);
    renderThumbnail(appImage(), getSrc);

    act(() => FakeIntersectionObserver.instances[0]!.intersect(true));
    expect(getSrc).toHaveBeenCalledWith("thumb-1");
    expect(screen.queryByRole("img")).toBeNull();
  });

  // ---- The library now shows originals, not renditions --------------------
  //
  // The three tests replaced here asserted that an original, a crop, and an
  // unlabelled record all rendered as *placeholders* — because the grid used
  // to display only records carrying the thumbnail label, i.e. the renditions
  // themselves. That inverted what a library is: it made a photo unclickable
  // until something derived from it, and a grid of a fresh import was a grid of
  // grey boxes.
  //
  // The grid now lists originals and displays a *rendition of* each, resolved
  // server-side from a requested pixel size.

  it("shows the rendition the server resolved for the tile size", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/original");
    renderThumbnail(
      appImage({
        id: "orig-2",
        parentId: null,
        derivedKind: null,
        variants: { "540": { url: "https://signed/tile", width: 540, height: 360 } },
      }),
      getSrc,
    );

    act(() => FakeIntersectionObserver.instances[0]!.intersect(true));
    expect(screen.getByRole("img").getAttribute("src")).toBe("https://signed/tile");
    // The original's own bytes are never fetched when a rendition exists —
    // that is the entire economic argument for the ladder.
    expect(getSrc).not.toHaveBeenCalled();
  });

  it("does not fetch a large original's bytes just to fill a 180px tile", () => {
    // A record mid-derivation has no renditions yet. Serving the original into
    // a tile would mean downloading tens of megabytes for a thumbnail, which is
    // exactly the cost the ladder exists to avoid — so it shows a placeholder
    // and waits.
    const getSrc = vi.fn().mockReturnValue("https://signed/huge");
    renderThumbnail(
      appImage({ id: "big", parentId: null, derivedKind: null, sizeBytes: 40_000_000 }),
      getSrc,
    );

    act(() => FakeIntersectionObserver.instances[0]!.intersect(true));
    expect(getSrc).not.toHaveBeenCalled();
  });

  it("serves a small original directly when it has no renditions yet", () => {
    // Below the direct-serve floor the round trip through derivation is not
    // worth waiting for, and the bytes are about the size of a rendition
    // anyway.
    const getSrc = vi.fn().mockReturnValue("https://signed/small");
    renderThumbnail(
      appImage({ id: "small", parentId: null, derivedKind: null, sizeBytes: 20_000 }),
      getSrc,
    );

    act(() => FakeIntersectionObserver.instances[0]!.intersect(true));
    expect(getSrc).toHaveBeenCalledWith("small");
  });

  it("still asks for nothing until the tile is near the viewport", () => {
    const getSrc = vi.fn().mockReturnValue("https://signed/x");
    renderThumbnail(
      appImage({
        id: "orig-3",
        parentId: null,
        derivedKind: null,
        variants: { "540": { url: "https://signed/tile", width: 540, height: 360 } },
      }),
      getSrc,
    );

    act(() => FakeIntersectionObserver.instances[0]!.intersect(false));
    expect(screen.queryByRole("img")).toBeNull();
  });
});
