import { describe, expect, it } from "vitest";
import {
  canonicalMeasuredTarget,
  containRenderedLongEdge,
  coverRenderedLongEdge,
  measuredPhysicalLongEdge,
  normalizedDevicePixelRatio,
} from "../src/photos-lib/render-geometry";

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

  it("falls back invalid display density to one", () => {
    expect(normalizedDevicePixelRatio(undefined)).toBe(1);
    expect(normalizedDevicePixelRatio(0)).toBe(1);
    expect(normalizedDevicePixelRatio(2)).toBe(2);
  });
});
