import { describe, expect, it } from "vitest";
import {
  canonicalMeasuredTarget,
  containRenderedLongEdge,
  coverRenderedLongEdge,
  measuredPhysicalLongEdge,
  normalizedDevicePixelRatio,
} from "../src/render-geometry";

const policy = {
  kind: "still" as const,
  version: "test",
  targetLongEdges: [128, 400, 1280, 2560, 4272],
};

describe("render target geometry", () => {
  it("computes cover and contain from the rendered source, including cropping", () => {
    expect(coverRenderedLongEdge({ width: 4000, height: 3000 }, { width: 180, height: 120 })).toBe(180);
    expect(coverRenderedLongEdge({ width: 3000, height: 4000 }, { width: 180, height: 120 })).toBe(240);
    expect(containRenderedLongEdge({ width: 4000, height: 3000 }, { width: 900, height: 600 })).toBe(800);
    expect(containRenderedLongEdge({ width: 3000, height: 4000 }, { width: 900, height: 600 })).toBe(600);
  });

  it("applies orientation, DPR, one final ceil, and source capping", () => {
    expect(measuredPhysicalLongEdge({
      source: { width: 3000, height: 4000 },
      container: { width: 180, height: 120 },
      orientation: 6,
      fit: "cover",
      devicePixelRatio: 2.001,
    })).toBe(361);
    expect(measuredPhysicalLongEdge({
      source: { width: 300, height: 200 },
      container: { width: 1000, height: 1000 },
      fit: "cover",
      devicePixelRatio: 3,
    })).toBe(300);
  });

  it("uses the container for unknown sources and ignores zero observations", () => {
    expect(measuredPhysicalLongEdge({
      source: null,
      container: { width: 180, height: 120 },
      fit: "contain",
      devicePixelRatio: 2,
    })).toBe(360);
    expect(measuredPhysicalLongEdge({
      source: null,
      container: { width: 0, height: 120 },
      fit: "contain",
    })).toBeNull();
  });

  it("canonicalizes boundaries and clamps above the policy", () => {
    expect(canonicalMeasuredTarget(policy, 128)).toBe(128);
    expect(canonicalMeasuredTarget(policy, 129)).toBe(400);
    expect(canonicalMeasuredTarget(policy, 5000)).toBe(4272);
    expect(canonicalMeasuredTarget(policy, null)).toBeNull();
  });

  it("keeps contain-fit measurements off the rung above when they land on one", () => {
    // The case the phone's viewer and its justified tiles both sit on: a
    // container whose contain fit lands *exactly* on a rung boundary must ask
    // for that rung, not the one above it. `canonicalTarget` takes the first
    // target `>= required`, so an off-by-one in the measurement is the
    // difference between fetching 1280 and fetching 2560 — four times the bytes
    // for a picture nothing can tell apart at that size.
    const contained = measuredPhysicalLongEdge({
      source: { width: 3000, height: 4000 },
      container: { width: 320, height: 320 },
      fit: "contain",
      devicePixelRatio: 4,
    });
    expect(contained).toBe(1280);
    expect(canonicalMeasuredTarget(policy, contained)).toBe(1280);

    // One pixel more of container is a whole rung more of request, which is why
    // the boundary is asserted from both sides rather than approached from one.
    const overByOne = measuredPhysicalLongEdge({
      source: { width: 3000, height: 4000 },
      container: { width: 320.25, height: 320.25 },
      fit: "contain",
      devicePixelRatio: 4,
    });
    expect(overByOne).toBe(1281);
    expect(canonicalMeasuredTarget(policy, overByOne)).toBe(2560);
  });

  it("measures contain against the displayed shape, not the stored one", () => {
    // Orientation is what makes this a real case rather than a rewording of the
    // one above. A portrait photograph stored landscape with `orientation: 6`
    // fits a portrait box on its *height*, and reading the stored width instead
    // asks for a rung and a half more than the box can show.
    const upright = measuredPhysicalLongEdge({
      source: { width: 4000, height: 3000 },
      container: { width: 300, height: 400 },
      orientation: 6,
      fit: "contain",
      devicePixelRatio: 3,
    });
    // Displayed 3000x4000 into 300x400 is a scale of 0.1, so the long edge is
    // 400 points and 1200 pixels — where the uncorrected shape would have
    // measured 400 points on the *width* and asked for 1600.
    expect(upright).toBe(1200);
    expect(canonicalMeasuredTarget(policy, upright)).toBe(1280);
  });

  it("falls back invalid display density to one", () => {
    expect(normalizedDevicePixelRatio(undefined)).toBe(1);
    expect(normalizedDevicePixelRatio(0)).toBe(1);
    expect(normalizedDevicePixelRatio(2)).toBe(2);
  });
});
