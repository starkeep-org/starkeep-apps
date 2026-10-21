// @vitest-environment jsdom
/**
 * A video tile picks up a poster that lands after the grid first asked.
 *
 * The regression, seen on 2026-10-21: a phone publishes a video record and,
 * seconds later, its posters. The grid asked in between, got a decision with
 * no poster, and cached it as settled, so the change kick that announced the
 * posters re-asked nothing and the tile kept its placeholder until a reload.
 * Stills never had the bug because a missing still rung answers `pending`.
 *
 * This drives the real tile, provider and cache, and calls `refreshPending`
 * the way `app.tsx` does on every freshness kick.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppImage } from "../src/photos-lib";
import { PhotoThumbnail } from "../src/photos-ui/components/grid/photo-thumbnail";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import {
  RenditionResolutionProvider,
  useRenditionResolutionCache,
} from "../src/photos-ui/context/rendition-resolution-context";
import type { RenditionResolutionCache } from "../src/lib/rendition-resolution-client";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  elements: Element[] = [];
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element) { this.elements.push(element); }
  disconnect() {}
  unobserve() {}
  intersect() {
    this.callback(this.elements.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry), this as never);
  }
}

const policies = {
  still: { kind: "still" as const, version: "still-test", targetLongEdges: [128, 400, 1280] },
  video: { kind: "video" as const, version: "video-test", targetLongEdges: [400, 1280] },
};

/** Large enough that the tile never falls back to serving the original itself. */
const video: AppImage = {
  id: "clip",
  mimeType: "video/mp4",
  objectStorageKey: "shared/video/clip",
  sizeBytes: 391_684_623,
  createdAt: "2026-10-21T16:20:00.000Z",
  updatedAt: "2026-10-21T16:20:00.000Z",
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
  originalFilename: "PXL_20261021_161906158.mp4",
  effectiveDateTaken: "2026-10-21T16:20:00.000Z",
};

const POSTER_URL = "http://127.0.0.1:9820/data/files/poster-720p";

/** Answers with whatever the server holds at the moment of each request. */
function serverHolding(state: { poster: boolean }) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const requests = JSON.parse(String(init?.body)).requests as Array<{ recordId: string; targetLongEdge: number }>;
    return new Response(JSON.stringify({
      policies,
      results: requests.map((request) => ({
        recordId: request.recordId,
        status: "resolved",
        mediaKind: "video",
        policyVersion: policies.video.version,
        canonicalTargetLongEdge: request.targetLongEdge,
        decision: state.poster
          ? { poster: { id: "poster", type: "image/jpeg", width: 1280, height: 720, long_edge: 1280, url: POSTER_URL } }
          : {},
      })),
    }), { status: 200 });
  });
}

let cache: RenditionResolutionCache | null = null;
function CaptureCache() {
  cache = useRenditionResolutionCache();
  return null;
}

function renderGrid() {
  return render(
    <RenditionResolutionProvider policies={policies}>
      <CaptureCache />
      <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => "unexpected-original"}>
        <PhotoThumbnail image={video} width={180} height={120} onSelect={() => {}} />
      </PhotoUrlProvider>
    </RenditionResolutionProvider>,
  );
}

async function settle() {
  await act(async () => vi.advanceTimersByTimeAsync(20));
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  cache = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a video poster that arrives after the grid asked", () => {
  it("paints on the next freshness kick, without a reload", async () => {
    const server = { poster: false };
    const fetchMock = serverHolding(server);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderGrid();

    act(() => FakeIntersectionObserver.instances.forEach((observer) => observer.intersect()));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")).toBeNull();

    // The phone's posters land, and the data server kicks the grid.
    server.poster = true;
    act(() => cache!.refreshPending());
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(POSTER_URL);
  });
});
