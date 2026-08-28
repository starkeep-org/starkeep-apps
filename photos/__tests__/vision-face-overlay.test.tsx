// @vitest-environment jsdom
/**
 * The bounding-box overlay.
 *
 * The invariant worth a test is the coordinate space. The worker rotates by
 * EXIF *before* inference, so a sidecar's `w`/`h` are the **displayed**
 * dimensions — which on an orientation-tagged photo are the record's stored ones
 * transposed. Scaling boxes by the record's numbers instead looks correct on
 * every photo that carries no orientation tag, which is most of them, and is the
 * failure the plan calls "the kind of bug that survives a demo".
 *
 * The overlay therefore takes its dimensions from the sidecar and from nowhere
 * else, and reproduces `objectFit: contain` in CSS so the boxes track the
 * rendered image without measuring it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { FaceOverlay } from "../src/photos-ui/components/vision/face-overlay";

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

interface FaceView {
  index: number;
  bbox: [number, number, number, number];
  score: number;
  personId: string | null;
  name: string;
}

function respondWith(body: unknown, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function face(over: Partial<FaceView> = {}): FaceView {
  return {
    index: 0,
    bbox: [100, 200, 50, 60],
    score: 0.9,
    personId: null,
    name: "",
    ...over,
  };
}

/** Renders and lets the overlay's fetch settle. */
async function renderOverlay(props: { recordId?: string; visible?: boolean } = {}) {
  await act(async () => {
    render(<FaceOverlay recordId={props.recordId ?? "rec-1"} visible={props.visible ?? true} />);
  });
}

const boxes = () => screen.queryAllByTestId("face-box");

describe("visibility", () => {
  // The lookup is no longer gated on `visible`: the viewer decides whether to
  // offer a Faces toggle from what the overlay reports, so it has to ask before
  // anyone can toggle it. Drawing stays gated.
  it("draws nothing while hidden, but still reports what it found", async () => {
    respondWith({ processed: true, width: 100, height: 100, faces: [face()] });
    const onLoaded = vi.fn();
    await act(async () => {
      render(<FaceOverlay recordId="rec-1" visible={false} onLoaded={onLoaded} />);
    });
    expect(screen.queryByTestId("face-overlay")).toBeNull();
    // The URL is the assertion; the init is the session-recovery wrapper's
    // doing and says nothing about this component.
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("/api/vision/faces/rec-1");
    expect(onLoaded).toHaveBeenCalledWith(
      expect.objectContaining({ processed: true, faces: [expect.anything()] }),
    );
  });

  it("renders nothing for an unscanned image", async () => {
    respondWith({ processed: false, faces: [] });
    await renderOverlay();
    expect(screen.queryByTestId("face-overlay")).toBeNull();
  });

  it("renders nothing for a scanned image with no faces", async () => {
    respondWith({ processed: true, width: 640, height: 480, faces: [] });
    await renderOverlay();
    expect(screen.queryByTestId("face-overlay")).toBeNull();
  });

  it("stays silent when the request fails", async () => {
    // The overlay is decoration on top of a photo. An error banner over the
    // image would be worse than no boxes.
    fetchMock.mockRejectedValue(new Error("network"));
    await renderOverlay();
    expect(screen.queryByTestId("face-overlay")).toBeNull();
  });

  it("stays silent when the routes report 501", async () => {
    respondWith({ error: "not on-device" }, 501);
    await renderOverlay();
    expect(screen.queryByTestId("face-overlay")).toBeNull();
  });

  it("reports what it loaded to its parent", async () => {
    // The viewer's Faces button uses this to say how many were found, and to
    // distinguish "not scanned" from "none here".
    const onLoaded = vi.fn();
    respondWith({ processed: true, width: 100, height: 100, faces: [face(), face({ index: 1 })] });
    await act(async () => {
      render(<FaceOverlay recordId="rec-1" visible onLoaded={onLoaded} />);
    });
    expect(onLoaded).toHaveBeenCalledWith(
      expect.objectContaining({ processed: true, faces: expect.any(Array) }),
    );
    expect(onLoaded.mock.calls[0][0].faces).toHaveLength(2);
  });
});

describe("positioning", () => {
  it("places a box as a percentage of the sidecar's dimensions", async () => {
    respondWith({
      processed: true,
      width: 1000,
      height: 500,
      faces: [face({ bbox: [100, 50, 200, 100] })],
    });
    await renderOverlay();

    const style = boxes()[0].style;
    expect(style.left).toBe("10%");
    expect(style.top).toBe("10%");
    expect(style.width).toBe("20%");
    expect(style.height).toBe("20%");
  });

  it("uses the sidecar's transposed dimensions on a rotated photo", async () => {
    // The same face, on a photo whose stored dimensions are 3000×4000 but whose
    // *display* dimensions are 4000×3000. Scaling by the record's numbers would
    // put this box at 25%/25% instead of 18.75%/33.3% — plausible, and wrong on
    // exactly the subset of photos that carry an orientation tag.
    respondWith({
      processed: true,
      width: 4000,
      height: 3000,
      faces: [face({ bbox: [750, 1000, 400, 300] })],
    });
    await renderOverlay();

    const style = boxes()[0].style;
    expect(Number.parseFloat(style.left)).toBeCloseTo(18.75, 4);
    expect(Number.parseFloat(style.top)).toBeCloseTo(33.3333, 3);
    expect(Number.parseFloat(style.width)).toBeCloseTo(10, 4);
    expect(Number.parseFloat(style.height)).toBeCloseTo(10, 4);
  });

  it("constrains its box to the sidecar's aspect ratio", async () => {
    // Reproduces the <img>'s `objectFit: contain` so the boxes track the
    // rendered photo — including when the viewer has no dimensions yet and
    // letterboxes the image into a fixed rectangle.
    respondWith({ processed: true, width: 1600, height: 900, faces: [face()] });
    await renderOverlay();

    const inner = screen.getByTestId("face-overlay").firstElementChild as HTMLElement;
    expect(inner.style.aspectRatio).toBe("1600 / 900");
    expect(inner.style.maxWidth).toBe("100%");
    expect(inner.style.maxHeight).toBe("100%");
  });

  it("does not intercept clicks on the photo", async () => {
    respondWith({ processed: true, width: 100, height: 100, faces: [face()] });
    await renderOverlay();
    expect(screen.getByTestId("face-overlay").style.pointerEvents).toBe("none");
  });

  it("renders one box per face", async () => {
    respondWith({
      processed: true,
      width: 100,
      height: 100,
      faces: [face({ index: 0 }), face({ index: 1 }), face({ index: 2 })],
    });
    await renderOverlay();
    expect(boxes()).toHaveLength(3);
  });
});

describe("names", () => {
  it("labels a box whose cluster has been named", async () => {
    respondWith({
      processed: true,
      width: 100,
      height: 100,
      faces: [face({ personId: "p1", name: "Alice" })],
    });
    await renderOverlay();
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("shows no label for an unnamed cluster", async () => {
    respondWith({
      processed: true,
      width: 100,
      height: 100,
      faces: [face({ personId: "p1", name: "" })],
    });
    await renderOverlay();
    expect(boxes()[0].textContent).toBe("");
  });
});

describe("switching photos", () => {
  it("re-fetches and does not carry the previous photo's boxes", async () => {
    respondWith({ processed: true, width: 100, height: 100, faces: [face(), face({ index: 1 })] });
    const { rerender } = render(<FaceOverlay recordId="rec-1" visible />);
    await act(async () => {});
    expect(boxes()).toHaveLength(2);

    respondWith({ processed: false, faces: [] });
    await act(async () => {
      rerender(<FaceOverlay recordId="rec-2" visible />);
    });
    expect(screen.queryByTestId("face-overlay")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("rec-2");
  });
});
