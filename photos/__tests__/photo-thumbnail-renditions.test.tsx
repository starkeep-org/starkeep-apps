// @vitest-environment jsdom
/**
 * What a tile paints, and what it asks for, given what the server said about
 * its renditions.
 *
 * These are the three outcomes the ideal-and-fallback shape exists to
 * distinguish, and they look identical to a tile holding only a resolved
 * variant: a rung that is here, a rung that is coming, and a rung that is never
 * coming from this node. Each needs different pixels and a different action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { PhotoThumbnail } from "../src/photos-ui/components/grid/photo-thumbnail";
import { PhotoUrlProvider } from "../src/photos-ui/context/photo-url-context";
import { requestDerivation, resetDerivationRequests } from "../src/lib/on-demand-derivation";
import type { AppImage } from "../src/photos-lib";
import { tileTargetLongEdge } from "../src/photos-lib/variant-src";

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

// The tile computes its own target from its width and the device pixel ratio,
// so the fixture has to key on the same number rather than a literal.
const TARGET = tileTargetLongEdge(180, 1);

function appImage(over: Partial<AppImage> = {}): AppImage {
  return {
    id: "rec-1",
    mimeType: "image/jpeg",
    objectStorageKey: "shared/image/aa/hash",
    sizeBytes: 8 * 1024 * 1024,
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

function renderTile(image: AppImage) {
  return render(
    <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={() => null}>
      <PhotoThumbnail image={image} onSelect={() => {}} />
    </PhotoUrlProvider>,
  );
}

function show(image: AppImage) {
  renderTile(image);
  act(() => FakeIntersectionObserver.instances[0]!.intersect(true));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  resetDerivationRequests();
  fetchMock = vi.fn(async (url: string) =>
    url.includes("starkeep-runtime-config")
      ? new Response(JSON.stringify({ apiGatewayUrl: "https://gw.invalid", lambdaConcurrency: 10 }))
      : new Response(JSON.stringify({ ok: true })),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the ideal rung is available", () => {
  it("paints it and asks for nothing", async () => {
    show(
      appImage({
        renditions: {
          [String(TARGET)]: {
            ideal: {
              longEdge: 1280,
              available: true,
              url: "https://renditions.invalid/1280",
              width: 1280,
              height: 960,
            },
          },
        },
      }),
    );
    expect((screen.getByRole("img") as HTMLImageElement).src).toBe(
      "https://renditions.invalid/1280",
    );
    await act(async () => {});
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/resize"))).toBe(false);
  });
});

describe("the ideal rung is still deriving", () => {
  it("paints the fallback rather than nothing", async () => {
    show(
      appImage({
        renditions: {
          [String(TARGET)]: {
            ideal: { longEdge: 1280, available: false, state: "pending" },
            fallback: {
              longEdge: 400,
              available: true,
              url: "https://renditions.invalid/400",
              width: 400,
              height: 300,
            },
          },
        },
      }),
    );
    expect((screen.getByRole("img") as HTMLImageElement).src).toBe(
      "https://renditions.invalid/400",
    );
  });

  it("asks the server to derive the rung it was told is missing", async () => {
    show(
      appImage({
        renditions: {
          [String(TARGET)]: {
            ideal: { longEdge: 1280, available: false, state: "pending" },
          },
        },
      }),
    );
    // The scheduler resolves its budget from runtime config first, so the
    // request is one turn behind the render.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const resize = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/resize"));
    expect(resize, "no derivation was requested").toBeTruthy();
    const body = JSON.parse((resize![1] as RequestInit).body as string) as {
      targetId: string;
      targetLongEdge: number;
    };
    expect(body.targetId).toBe("rec-1");
    // In pixels. Naming a size class here would put the ladder in the client.
    expect(body.targetLongEdge).toBe(1280);
  });

  it("does not ask twice for the same record and target", async () => {
    const image = appImage({
      renditions: {
        [String(TARGET)]: { ideal: { longEdge: 1280, available: false, state: "pending" } },
      },
    });
    show(image);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    cleanup();
    FakeIntersectionObserver.instances = [];
    show(image);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/resize"))).toHaveLength(1);
  });

  it("allows the viewer to request a larger target after the grid target", async () => {
    requestDerivation("rec-1", 400);
    requestDerivation("rec-1", 2048);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/api/resize"))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).targetLongEdge);
    expect(bodies).toEqual([400, 2048]);
  });
});

describe("nothing here can derive it", () => {
  const undecodable = appImage({
    mimeType: "image/heic",
    renditions: {
      [String(TARGET)]: {
        ideal: { longEdge: 1280, available: false, state: "undecodable-here" },
      },
    },
  });

  it("says so, instead of showing a grey box forever", async () => {
    show(undecodable);
    expect(screen.getByText("Cannot be displayed")).toBeTruthy();
  });

  it("never asks for a derivation that would fail every time", async () => {
    show(undecodable);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/resize"))).toBe(false);
  });

  it("explains that the photo is intact and this fixes itself", async () => {
    show(undecodable);
    fireEvent.click(screen.getByLabelText("Why can this photo not be displayed?"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/safe and unmodified/);
    expect(dialog.textContent).toMatch(/automatically/);
  });
});
