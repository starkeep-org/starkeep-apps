// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppImage } from "../src/photos-lib";
import { PhotoThumbnail } from "../src/photos-ui/components/grid/photo-thumbnail";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import { RenditionResolutionProvider } from "../src/photos-ui/context/rendition-resolution-context";

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

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  element: Element | null = null;
  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element) { this.element = element; }
  disconnect() {}
  unobserve() {}
  resize(width: number, height: number) {
    this.callback([{ target: this.element!, contentRect: { width, height } } as ResizeObserverEntry], this as never);
  }
}

const policies = {
  still: { kind: "still" as const, version: "still-test", targetLongEdges: [128, 400, 1280] },
  video: { kind: "video" as const, version: "video-test", targetLongEdges: [400, 1280] },
};

function image(id: string, width = 4000, height = 3000): AppImage {
  return {
    id,
    mimeType: "image/jpeg",
    objectStorageKey: `shared/image/${id}`,
    sizeBytes: 1_000_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parentId: null,
    derivedKind: null,
    variants: {},
    thumbHash: null,
    width,
    height,
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
    originalFilename: `${id}.jpg`,
    effectiveDateTaken: "2026-01-01T00:00:00.000Z",
  };
}

function Gallery() {
  return (
    <RenditionResolutionProvider policies={policies}>
      <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
        <PhotoThumbnail image={image("a")} onSelect={() => {}} />
        <PhotoThumbnail image={image("b", 300, 200)} onSelect={() => {}} />
      </PhotoUrlProvider>
    </RenditionResolutionProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeIntersectionObserver.instances = [];
  FakeResizeObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("measured thumbnail resolution", () => {
  it("waits for intersection and a positive size, then coalesces canonical requests", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const requests = JSON.parse(String(init?.body)).requests as Array<{ recordId: string; targetLongEdge: number }>;
      const responseBody = {
        policies,
        results: requests.map((request) => ({
          recordId: request.recordId,
          status: "resolved",
          mediaKind: "still",
          policyVersion: policies.still.version,
          canonicalTargetLongEdge: request.targetLongEdge,
          decision: { ideal: { id: `${request.recordId}-r`, available: true, longEdge: request.targetLongEdge, width: request.targetLongEdge, height: 300, url: `https://example.test/${request.recordId}` } },
        })),
      };
      return new Response(JSON.stringify(responseBody), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Gallery />);

    act(() => FakeResizeObserver.instances.forEach((observer) => observer.resize(180, 120)));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => FakeIntersectionObserver.instances.forEach((observer) => observer.intersect()));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(20));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.requests).toEqual([
      expect.objectContaining({ recordId: "a", requiredLongEdge: 360, targetLongEdge: 400 }),
      // The small source is capped before canonicalization.
      expect.objectContaining({ recordId: "b", requiredLongEdge: 300, targetLongEdge: 400 }),
    ]);
  });
});
