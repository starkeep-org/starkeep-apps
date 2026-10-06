// @vitest-environment jsdom
/**
 * The viewer's delete control.
 *
 * Deletion had no entry point at all: the route existed, the reducer case existed
 * and was never dispatched, and nothing in the UI reached either. This is the
 * control, and what it is careful about.
 *
 * The viewer stays presentational. It owns the confirmation, the in-flight state and
 * the refusal message; the caller owns the request and the library state it changes.
 * So the button appears only when a caller supplies `onDelete`, which is also why
 * every other viewer test can render without one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
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

async function open(options: { onDelete?: () => Promise<void> } = {}) {
  const rendered = render(
    <RenditionResolutionProvider policies={policies}>
      <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
        <PhotoViewer
          image={appImage()}
          onClose={() => {}}
          {...(options.onDelete ? { onDelete: options.onDelete } : {})}
        />
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

describe("the delete control", () => {
  it("is absent when no caller offers a delete", async () => {
    // Which is what keeps the viewer presentational: a control that is always there
    // would make every caller own a delete, including the ones that cannot.
    await open();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("asks first, and does nothing when the person declines", async () => {
    const onDelete = vi.fn(async () => {});
    vi.stubGlobal("confirm", vi.fn(() => false));
    await open({ onDelete });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("says what the person gets back, so the confirmation is not a bare warning", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await open({ onDelete: async () => {} });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const message = confirm.mock.calls[0]![0] as string;
    expect(message).toContain("photo.jpg");
    expect(message).toContain("Drive's Trash");
    expect(message).toContain("restore");
  });

  it("hands the delete to the caller once confirmed", async () => {
    const onDelete = vi.fn(async () => {});
    vi.stubGlobal("confirm", vi.fn(() => true));
    await open({ onDelete });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("stays open and shows a refusal rather than closing on a failure", async () => {
    // The reason this is not optimistic: a failure the person has to be told about
    // somewhere the viewer no longer is, in exchange for one round trip to this
    // machine, is the worse half of the bargain.
    vi.stubGlobal("confirm", vi.fn(() => true));
    await open({
      onDelete: async () => {
        throw new Error("the canonical stand-in is what the person sees");
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("canonical stand-in");
    // And the control is usable again, so a transient failure can be retried.
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("says it is working while the caller's promise is in flight", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    let release: (() => void) | null = null;
    await open({ onDelete: () => new Promise<void>((r) => (release = () => r())) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    const button = screen.getByRole("button", { name: "Deleting…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => {
      release!();
    });
  });
});
