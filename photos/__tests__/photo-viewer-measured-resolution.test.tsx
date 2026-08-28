// @vitest-environment jsdom
/**
 * What the viewer asks the server for, given the box it can actually paint.
 *
 * The sizing contract is that the viewer resolves the rung covering the
 * *contained image*, not the stage and not the window. That is invisible from
 * the response — a 2560 answer to an overstated requirement looks exactly like
 * a 2560 answer to an honest one — so these assert the requirement the viewer
 * computes, not the rendition it receives.
 *
 * The viewer computes its stage from the viewport rather than observing it, so
 * these drive it by setting `window.innerWidth`/`innerHeight`. A portrait photo
 * is height-bound on every viewport used here, which makes the stage's long
 * edge `innerHeight` minus the 120 px chrome allowance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { AppImage } from "../src/photos-lib";
import { PhotoViewer } from "../src/photos-ui/components/viewer/photo-viewer";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import { RenditionResolutionProvider } from "../src/photos-ui/context/rendition-resolution-context";

const policies = {
  still: { kind: "still" as const, version: "still-test", targetLongEdges: [128, 400, 1280, 2560, 4272] },
  video: { kind: "video" as const, version: "video-test", targetLongEdges: [400, 1280] },
};

/**
 * Set the viewport the viewer computes its stage from.
 *
 * Dispatches `resize` so an already-mounted viewer picks the change up, and is
 * safe to call before `render` because the hook reads the window during its
 * first render rather than after mount.
 */
function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

/** Chrome allowance the viewer subtracts from the viewport height. */
const CHROME = 120;

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
    width: 3024,
    height: 4032,
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

/** Every request body the viewer sent, flattened across batches. */
function requestsFrom(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.flatMap((call) => {
    const init = call[1] as RequestInit | undefined;
    return init?.body ? JSON.parse(String(init.body)).requests : [];
  });
}

/** Just the canonical targets asked for, in order. */
function targetsFrom(fetchMock: ReturnType<typeof vi.fn>) {
  return requestsFrom(fetchMock).map((request: { targetLongEdge: number }) => request.targetLongEdge);
}

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const requests = JSON.parse(String(init?.body)).requests as Array<{
      recordId: string;
      targetLongEdge: number;
    }>;
    return new Response(
      JSON.stringify({
        policies,
        results: requests.map((request) => ({
          recordId: request.recordId,
          status: "resolved",
          mediaKind: "still",
          policyVersion: policies.still.version,
          canonicalTargetLongEdge: request.targetLongEdge,
          decision: {
            ideal: {
              id: `${request.recordId}-${request.targetLongEdge}`,
              available: true,
              longEdge: request.targetLongEdge,
              width: request.targetLongEdge,
              height: request.targetLongEdge,
              url: `https://example.test/${request.targetLongEdge}`,
            },
          },
        })),
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * Let the queued batch flush. The cache debounces before sending, and a resize
 * that changes the target queues another, so two passes cover a render and a
 * subsequent resize alike.
 */
async function settle() {
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => vi.advanceTimersByTimeAsync(200));
}

function renderViewer(image = appImage()) {
  return render(
    <RenditionResolutionProvider policies={policies}>
      <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
        <PhotoViewer image={image} onClose={() => {}} />
      </PhotoUrlProvider>
    </RenditionResolutionProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // 468 CSS px of stage height (588 − 120), and width to spare so the portrait
  // photo stays height-bound.
  setViewport(1000, 468 + CHROME);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("viewer measured resolution", () => {
  it("asks for the rung covering the contained image, not the window", async () => {
    const fetchMock = stubFetch();
    renderViewer();

    await settle();

    // 468 CSS px of contained image at 2× is 936 physical px, which the policy
    // rounds up to 1280. The window's own long edge is 1000, and asking on that
    // basis would have cost 2000 physical px and the 2560 rung.
    expect(requestsFrom(fetchMock)).toEqual([
      expect.objectContaining({ requiredLongEdge: 936, targetLongEdge: 1280 }),
    ]);
  });

  it("scales the requirement with device pixel ratio", async () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
    const fetchMock = stubFetch();
    renderViewer();

    await settle();

    // The same box on a 3× screen needs 1404 px, which clears 1280 and so
    // costs the 2560 rung. The gap between those two rungs is the whole reason
    // the requirement is worth logging rather than inferring from the answer.
    expect(requestsFrom(fetchMock)).toEqual([
      expect.objectContaining({ requiredLongEdge: 1404, targetLongEdge: 2560 }),
    ]);
  });

  it("resolves again only when a resize crosses a threshold", async () => {
    const fetchMock = stubFetch();
    renderViewer();
    await settle();
    expect(targetsFrom(fetchMock)).toEqual([1280]);

    // A 400 px stage is 800 physical px — a different box, the same rung, so
    // nothing is asked for and the loaded URL stands.
    act(() => setViewport(1000, 400 + CHROME));
    await settle();
    expect(targetsFrom(fetchMock)).toEqual([1280]);

    // A 1200 px stage is 2400 px, which is over the 1280 boundary.
    act(() => setViewport(1600, 1200 + CHROME));
    await settle();
    expect(targetsFrom(fetchMock)).toEqual([1280, 2560]);
  });

  it("caps the requirement at a source smaller than its box", async () => {
    const fetchMock = stubFetch();
    renderViewer(appImage({ width: 300, height: 400 }));

    await settle();

    expect(requestsFrom(fetchMock)).toEqual([
      expect.objectContaining({ requiredLongEdge: 400, targetLongEdge: 400 }),
    ]);
  });
});
