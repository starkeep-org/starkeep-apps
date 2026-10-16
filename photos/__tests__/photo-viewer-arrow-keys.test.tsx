// @vitest-environment jsdom
/**
 * Browsing from the viewer with the arrow keys.
 *
 * The viewer only reports which way the person asked to move; the caller owns the
 * list and decides what is before and after. So an end of the list is a missing
 * callback, and the keys must leave alone the elements that need them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { PhotoViewer } from "../src/photos-ui/components/viewer/photo-viewer";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import { RenditionResolutionProvider } from "../src/photos-ui/context/rendition-resolution-context";
import type { AppImage } from "../src/photos-lib";
import { resetDerivationRequests } from "../src/lib/on-demand-derivation";

const policies = {
  still: { kind: "still" as const, version: "still-test", targetLongEdges: [320, 1280] },
  video: { kind: "video" as const, version: "video-test", targetLongEdges: [640] },
};

function appImage(): AppImage {
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
      present: null,
      orientation: null,
    },
    originalFilename: "photo.jpg",
    effectiveDateTaken: "2026-01-01T00:00:00.000Z",
  };
}

async function open(props: { onPrevious?: () => void; onNext?: () => void } = {}) {
  const rendered = render(
    <RenditionResolutionProvider policies={policies}>
      <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
        <PhotoViewer image={appImage()} onClose={() => {}} {...props} />
      </PhotoUrlProvider>
    </RenditionResolutionProvider>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  return rendered;
}

beforeEach(() => {
  resetDerivationRequests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ decisions: {} })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("arrow-key browsing", () => {
  it("moves to the previous photo on the left arrow and the next on the right", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    await open({ onPrevious, onNext });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("does nothing at an end of the list", async () => {
    // The caller expresses an end by passing no callback, so the key has nowhere to go.
    const onNext = vi.fn();
    await open({ onNext });
    expect(() => fireEvent.keyDown(window, { key: "ArrowLeft" })).not.toThrow();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("leaves arrow keys to the caption editor", async () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    await open({ onPrevious, onNext });
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    fireEvent.keyDown(textarea, { key: "ArrowLeft" });
    fireEvent.keyDown(textarea, { key: "ArrowRight" });
    expect(onPrevious).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
    textarea.remove();
  });

  it("leaves modified arrow keys to the browser", async () => {
    const onPrevious = vi.fn();
    await open({ onPrevious });
    fireEvent.keyDown(window, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it("still closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <RenditionResolutionProvider policies={policies}>
        <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
          <PhotoViewer image={appImage()} onClose={onClose} onNext={() => {}} />
        </PhotoUrlProvider>
      </RenditionResolutionProvider>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
