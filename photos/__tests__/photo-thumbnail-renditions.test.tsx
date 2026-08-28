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
import type { RenditionChoice } from "../src/photos-lib/rendition-resolution";
import { canonicalTarget, currentRenditionPolicies } from "../src/photos-lib/rendition-policy";
import { RenditionResolutionProvider } from "../src/photos-ui/context/rendition-resolution-context";

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

// The tile measures its own box, multiplies by the device pixel ratio, and
// canonicalizes against the published policy — so the fixture has to answer the
// target that path arrives at rather than a literal. A 180 × 120 tile covering a
// 4000 × 3000 source at a ratio of 1 requires 180 px, and the still policy
// rounds that up to its bottom rung.
const POLICIES = currentRenditionPolicies();
const TARGET = canonicalTarget(POLICIES.still, 180);

/** What the resolution endpoint answers for `rec-1` in the current test. */
let decision: RenditionChoice | null = null;

function resolutionResponse() {
  return {
    policies: POLICIES,
    results: decision
      ? [
          {
            recordId: "rec-1",
            status: "resolved" as const,
            mediaKind: "still" as const,
            policyVersion: POLICIES.still.version,
            canonicalTargetLongEdge: TARGET,
            decision,
          },
        ]
      : [],
  };
}

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

/** Stands in for the original's own bytes, so a test can prove nothing asked. */
let getFullSizeSrc: ReturnType<typeof vi.fn>;

function renderTile(image: AppImage) {
  return render(
    <RenditionResolutionProvider policies={POLICIES}>
      <PhotoUrlProvider getThumbnailSrc={() => null} getFullSizeSrc={getFullSizeSrc}>
        <PhotoThumbnail image={image} onSelect={() => {}} />
      </PhotoUrlProvider>
    </RenditionResolutionProvider>,
  );
}

/**
 * Render the tile, bring it into view, and let the batched resolution request
 * settle. The cache debounces before flushing, so a tile has no decision to
 * paint until that timer has run.
 */
async function show(image: AppImage, served: RenditionChoice | null = null) {
  decision = served;
  renderTile(image);
  act(() => FakeIntersectionObserver.instances[0]!.intersect(true));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  resetDerivationRequests();
  decision = null;
  getFullSizeSrc = vi.fn(() => "https://signed/original");
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("starkeep-runtime-config")) {
      return new Response(JSON.stringify({ apiGatewayUrl: "https://gw.invalid", lambdaConcurrency: 10 }));
    }
    if (url.includes("/api/photos/renditions")) {
      return new Response(JSON.stringify(resolutionResponse()));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the ideal rung is available", () => {
  it("paints it and asks for nothing", async () => {
    await show(appImage(), {
      ideal: {
        longEdge: 1280,
        available: true,
        url: "https://renditions.invalid/1280",
        width: 1280,
        height: 960,
      },
    });
    expect((screen.getByRole("img") as HTMLImageElement).src).toBe(
      "https://renditions.invalid/1280",
    );
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/resize"))).toBe(false);
    // The original's own bytes are never fetched when a rendition exists —
    // that is the entire economic argument for the ladder.
    expect(getFullSizeSrc).not.toHaveBeenCalled();
  });
});

describe("the ideal rung is still deriving", () => {
  it("paints the fallback rather than nothing", async () => {
    await show(appImage(), {
      ideal: { longEdge: 1280, available: false, state: "pending" },
      fallback: {
        longEdge: 320,
        available: true,
        url: "https://renditions.invalid/320",
        width: 320,
        height: 240,
      },
    });
    expect((screen.getByRole("img") as HTMLImageElement).src).toBe(
      "https://renditions.invalid/320",
    );
  });

  it("asks the server to derive the rung it was told is missing", async () => {
    await show(appImage(), { ideal: { longEdge: 1280, available: false, state: "pending" } });
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
    const image = appImage();
    const pending: RenditionChoice = {
      ideal: { longEdge: 1280, available: false, state: "pending" },
    };
    await show(image, pending);
    cleanup();
    FakeIntersectionObserver.instances = [];
    await show(image, pending);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/api/resize"))).toHaveLength(1);
  });

  it("allows the viewer to request a larger target after the grid target", async () => {
    requestDerivation("rec-1", 640);
    requestDerivation("rec-1", 2048);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const bodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/api/resize"))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).targetLongEdge);
    expect(bodies).toEqual([640, 2048]);
  });
});

describe("nothing here can derive it", () => {
  const undecodable = () => appImage({ mimeType: "image/heic" });
  const undecodableDecision: RenditionChoice = {
    ideal: { longEdge: 1280, available: false, state: "undecodable-here" },
  };

  it("says so, instead of showing a grey box forever", async () => {
    await show(undecodable(), undecodableDecision);
    expect(screen.getByText("Cannot be displayed")).toBeTruthy();
  });

  it("never asks for a derivation that would fail every time", async () => {
    await show(undecodable(), undecodableDecision);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/resize"))).toBe(false);
  });

  it("explains that the photo is intact and this fixes itself", async () => {
    await show(undecodable(), undecodableDecision);
    fireEvent.click(screen.getByLabelText("Why can this photo not be displayed?"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/safe and unmodified/);
    expect(dialog.textContent).toMatch(/automatically/);
  });
});
