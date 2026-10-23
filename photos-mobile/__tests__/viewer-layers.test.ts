/**
 * The viewer's layer stack: which `<Image>` layers a page keeps mounted, and
 * which ones may be opaque. See `StillStage` in `LibraryViewer.tsx` for why a
 * mounted layer is never re-pointed.
 */
import { describe, it, expect } from "vitest";
import {
  collapseBelow,
  dropLayer,
  initialStack,
  markDisplayed,
  withUri,
  type LayerStack,
} from "../src/ui/viewer-layers";

function stack(layers: string[], displayed: string[] = []): LayerStack {
  return { layers, displayed: new Set(displayed) };
}

/** A layer drawing, both halves: opaque on the display, the collapse a frame later. */
function display(current: LayerStack, layer: string): LayerStack {
  return collapseBelow(markDisplayed(current, layer), layer);
}

describe("initialStack", () => {
  it("mounts the rung that is here, undrawn", () => {
    const fresh = initialStack("tile");
    expect(fresh.layers).toEqual(["tile"]);
    expect(fresh.displayed.size).toBe(0);
  });

  it("mounts nothing when no rung is here", () => {
    expect(initialStack(null).layers).toEqual([]);
  });
});

describe("withUri", () => {
  it("appends a new URI above the picture already there", () => {
    expect(withUri(stack(["tile"], ["tile"]), "viewer").layers).toEqual(["tile", "viewer"]);
  });

  it("replaces a layer beneath that has not drawn yet", () => {
    // It has shown nothing, so nothing is lost; kept, it would draw and then be
    // replaced a frame or two later.
    expect(withUri(stack(["tile"]), "viewer").layers).toEqual(["viewer"]);
    expect(withUri(stack(["tile", "medium"], ["tile"]), "large").layers).toEqual([
      "tile",
      "large",
    ]);
  });

  it("mounts the first picture on a stage that mounted with nothing to draw", () => {
    expect(withUri(stack([]), "fetched").layers).toEqual(["fetched"]);
  });

  it("changes nothing when the URI is already on top", () => {
    const current = stack(["tile", "viewer"]);
    expect(withUri(current, "viewer")).toBe(current);
  });

  it("drops back to an earlier layer rather than mounting a second under its key", () => {
    expect(withUri(stack(["tile", "medium", "large"], ["tile"]), "medium").layers).toEqual([
      "tile",
      "medium",
    ]);
    const back = withUri(stack(["tile", "medium", "large"], ["tile"]), "tile");
    expect(back.layers).toEqual(["tile"]);
    expect(back.displayed.has("tile")).toBe(true);
  });

  it("mounts a URI that left the stack again as a fresh, undrawn layer", () => {
    // A display remembered from the earlier mount would make the new view
    // opaque before it has drawn anything.
    let current = display(stack(["tile", "large"], ["tile"]), "large");
    expect(current.layers).toEqual(["large"]);
    current = withUri(current, "tile");
    expect(current.layers).toEqual(["large", "tile"]);
    expect(current.displayed.has("tile")).toBe(false);
  });
});

describe("markDisplayed and collapseBelow", () => {
  it("keeps the layer beneath mounted on the display, and drops it a frame later", () => {
    const opaque = markDisplayed(stack(["tile", "large"], ["tile"]), "large");
    expect(opaque.layers).toEqual(["tile", "large"]);
    expect(opaque.displayed.has("large")).toBe(true);

    const collapsed = collapseBelow(opaque, "large");
    expect(collapsed.layers).toEqual(["large"]);
    expect([...collapsed.displayed]).toEqual(["large"]);
  });

  it("keeps the layers above a drawn layer, which are still decoding", () => {
    // A medium rung draws over the tile's while a large one decodes above both.
    const current = display(stack(["tile", "medium", "large"], ["tile"]), "medium");
    expect(current.layers).toEqual(["medium", "large"]);
    expect(current.displayed.has("large")).toBe(false);
  });

  it("drops every layer beneath when the top one draws first", () => {
    expect(display(stack(["tile", "medium", "large"], ["tile"]), "large").layers).toEqual(["large"]);
  });

  it("ignores a display from a layer that has already left the stack", () => {
    const current = display(stack(["tile", "large"], ["tile"]), "large");
    expect(markDisplayed(current, "tile")).toBe(current);
    expect(collapseBelow(current, "tile")).toBe(current);
  });

  it("changes nothing when the drawn layer is already alone", () => {
    const current = stack(["viewer"], ["viewer"]);
    expect(display(current, "viewer")).toBe(current);
  });
});

describe("dropLayer", () => {
  it("removes a failed rung and keeps the picture beneath it", () => {
    expect(dropLayer(stack(["tile", "large"], ["tile"]), "large").layers).toEqual(["tile"]);
  });

  it("empties the stack when the only rung fails", () => {
    expect(dropLayer(stack(["tile"]), "tile").layers).toEqual([]);
  });

  it("changes nothing for a layer that is not in the stack", () => {
    const current = stack(["tile"], ["tile"]);
    expect(dropLayer(current, "gone")).toBe(current);
  });
});
