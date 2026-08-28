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
import { RenditionResolutionProvider } from "../src/photos-ui/context/rendition-resolution-context";
import type { AppImage } from "../src/photos-lib";
import { resetDerivationRequests } from "../src/lib/on-demand-derivation";

/**
 * The viewer paints what the server resolved, so these tests hand it a resolved
 * decision rather than a signed URL for the original. The URL under test is the
 * rendition's; the cross-fade being asserted is presentation state and does not
 * care which of the two it came from.
 */
const policies = {
  still: { kind: "still" as const, version: "still-test", targetLongEdges: [320, 640, 1280, 2560, 4272] },
  video: { kind: "video" as const, version: "video-test", targetLongEdges: [640, 1280] },
};

/** The rendition URL the mocked resolution endpoint hands back. */
let resolvedUrl: string | null = null;

function appImage(over: Partial<AppImage> = {}): AppImage {
  return {
    id: "orig-1",
    mimeType: "image/jpeg",
    objectStorageKey: "shared/image/aa/hash",
    sizeBytes: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parentId: null,
    derivedKind: null,
  variants: {},
  thumbHash: null,
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

function viewer(image: AppImage) {
  return (
    <RenditionResolutionProvider policies={policies}>
      <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
        <PhotoViewer image={image} onClose={() => {}} />
      </PhotoUrlProvider>
    </RenditionResolutionProvider>
  );
}

function renderViewer(image: AppImage) {
  return render(viewer(image));
}

/**
 * Let the viewer settle. The viewer computes its stage during its first render,
 * so the only wait left is the resolution cache's batching delay before it
 * sends and the response it then applies.
 */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

async function open(image: AppImage, url: string | null) {
  resolvedUrl = url;
  const rendered = renderViewer(image);
  await settle();
  return rendered;
}

beforeEach(() => {
  resetDerivationRequests();
  resolvedUrl = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/photos/renditions")) {
      // Echo each request's own record and canonical target, which is what the
      // cache matches its pending entries against.
      const { requests } = JSON.parse(String(init?.body ?? "{}")) as {
        requests?: Array<{ recordId: string; targetLongEdge: number }>;
      };
      return new Response(JSON.stringify({
        policies,
        results: (resolvedUrl ? requests ?? [] : []).map((request) => ({
          recordId: request.recordId,
          status: "resolved",
          mediaKind: "still",
          policyVersion: policies.still.version,
          canonicalTargetLongEdge: request.targetLongEdge,
          decision: {
            ideal: {
              longEdge: request.targetLongEdge,
              available: true,
              url: resolvedUrl,
              width: request.targetLongEdge,
              height: Math.round(request.targetLongEdge * 0.75),
            },
          },
        })),
      }));
    }
    // The info panel (hidden by default) never fetches on mount, but answer
    // defensively so nothing hits the network if that ever changes.
    return new Response(JSON.stringify({ image: null }), { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PhotoViewer proportioning from record dimensions", () => {
  it("shapes the loader box to the record's real aspect ratio — no thumbnail measurement", async () => {
    // Portrait 600x800 → ratio 0.75, taken straight from width/height.
    await open(appImage({ width: 600, height: 800 }), null);

    const wrapper = screen.getByTestId("photo-skeleton").parentElement as HTMLElement;
    // CSS normalizes the numeric ratio to "<n> / 1".
    expect(wrapper.style.aspectRatio).toMatch(/^0\.75\b/);
  });

  it("is a plain gray pulse div (never a blurred thumbnail image)", async () => {
    await open(appImage({ width: 800, height: 600 }), null);

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

  it("shows the gray skeleton with the full image faded out over it while downloading", async () => {
    await open(appImage(), "https://signed/full");

    expect(skeleton()).toBeTruthy();
    // Full image is mounted (downloading) but transparent until it loads.
    expect(fullImg().src).toBe("https://signed/full");
    expect(fullImg().style.opacity).toBe("0");
  });

  it("cross-fades the full image in and removes the skeleton once it loads", async () => {
    await open(appImage(), "https://signed/full");

    act(() => fireEvent.load(fullImg()));

    expect(fullImg().style.opacity).toBe("1");
    expect(screen.queryByTestId("photo-skeleton")).toBeNull();
  });

  it("resets to the faded-out state when the resolved src changes (opening a different photo)", async () => {
    const { rerender } = await open(appImage({ id: "orig-a" }), "https://signed/a");
    act(() => fireEvent.load(fullImg()));
    expect(fullImg().style.opacity).toBe("1");

    resolvedUrl = "https://signed/b";
    rerender(viewer(appImage({ id: "orig-b" })));
    await settle();

    // New photo: full image transparent again until it loads, skeleton shown.
    expect(fullImg().src).toBe("https://signed/b");
    expect(fullImg().style.opacity).toBe("0");
    expect(screen.getByTestId("photo-skeleton")).toBeTruthy();
  });
});

describe("PhotoViewer without dimensions (metadata pending)", () => {
  const img = (c: HTMLElement) => c.querySelector("img") as HTMLImageElement | null;

  it("shows a fixed-height box and no <img> while the rendition is still resolving", async () => {
    const { container } = await open(appImage({ width: 0, height: 0 }), null);

    const skeleton = screen.getByTestId("photo-skeleton");
    expect(skeleton).toBeTruthy();
    // Box keeps a fixed height when there's no aspect ratio to shape it.
    const wrapper = skeleton.parentElement as HTMLElement;
    expect(wrapper.style.aspectRatio).toBe("");
    expect(wrapper.style.height).toContain("100vh");
    // No bare <img> with an absent src — that's what flashed the broken glyph.
    expect(img(container)).toBeNull();
  });

  it("keeps the <img> hidden behind the box until it finishes loading, then reveals it", async () => {
    const { container } = await open(appImage({ width: 0, height: 0 }), "https://signed/full");

    const el = img(container)!;
    expect(el.src).toBe("https://signed/full");
    expect(el.style.opacity).toBe("0");
    expect(screen.getByTestId("photo-skeleton")).toBeTruthy();

    act(() => fireEvent.load(el));
    expect(el.style.opacity).toBe("1");
    expect(screen.queryByTestId("photo-skeleton")).toBeNull();
  });
});

describe("PhotoViewer with a pending rendition", () => {
  it("waits for the requested size instead of silently downloading the original", async () => {
    // `resolvedUrl` null makes the endpoint answer with no result for the
    // record, which is what a rung mid-derivation looks like to the viewer.
    await open(appImage(), null);

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("photo-skeleton")).toBeTruthy();
  });
});
