/**
 * The viewer's layer stack: which `<Image>` layers a page keeps mounted, and
 * which one carries the ThumbHash. See `StillStage` in `LibraryViewer.tsx` for
 * why a mounted layer is never re-pointed.
 */
import { describe, it, expect } from "vitest";
import { collapseLayers, nextLayers, thumbHashLayer } from "../src/ui/viewer-layers";

describe("nextLayers", () => {
  it("appends a new URI above the picture already there", () => {
    expect(nextLayers(["tile"], "viewer")).toEqual(["tile", "viewer"]);
  });

  it("mounts the first picture on a stage that mounted with nothing to draw", () => {
    // A page whose bytes were not here opens on its ThumbHash, and a fetch then
    // brings a rung. The inline version of this rule kept the empty stack.
    expect(nextLayers([], "viewer")).toEqual(["viewer"]);
  });

  it("changes nothing when the URI is already on top", () => {
    // The same array, so React bails out rather than re-rendering every layer.
    const current = ["tile", "viewer"];
    expect(nextLayers(current, "viewer")).toBe(current);
  });

  it("drops back to an earlier layer rather than mounting a second under its key", () => {
    expect(nextLayers(["tile", "medium", "large"], "medium")).toEqual(["tile", "medium"]);
    expect(nextLayers(["tile", "medium", "large"], "tile")).toEqual(["tile"]);
  });
});

describe("collapseLayers", () => {
  it("leaves only the displayed layer when it is the top one", () => {
    expect(collapseLayers(["tile", "viewer"], "viewer")).toEqual(["viewer"]);
  });

  it("ignores a display from a layer that has since been superseded", () => {
    // The newer layer above it is still decoding, and must not be thrown away.
    const current = ["tile", "medium", "large"];
    expect(collapseLayers(current, "medium")).toBe(current);
  });

  it("changes nothing when the displayed layer is already alone", () => {
    const current = ["viewer"];
    expect(collapseLayers(current, "viewer")).toBe(current);
  });
});

describe("thumbHashLayer", () => {
  it("stays on the first layer mounted as later ones arrive", () => {
    // A placeholder that moved would reload the view it left, which is the
    // two-frame blackout this rule exists to prevent.
    let fixed: string | null = null;
    for (const uri of ["tile", "medium", "large"]) fixed = thumbHashLayer(fixed, uri);
    expect(fixed).toBe("tile");
  });

  it("goes to the first layer that arrives on a stage that mounted empty", () => {
    expect(thumbHashLayer(null, "viewer")).toBe("viewer");
  });
});
