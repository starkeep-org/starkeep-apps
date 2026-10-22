/**
 * How many pixels each surface asks for, and why the two never agree.
 *
 * The behaviour under test is that the request follows the *box a photograph is
 * drawn in*, not the surface it is drawn on. That is the whole difference from
 * what this replaced — a fixed fraction of a fixed three-column grid, one number
 * for a whole page, and nothing at all for the viewer.
 *
 * The numbers below are the plan's own table, and they are asserted as literals
 * on purpose. A target that moved with the ladder would assert nothing, and a
 * target computed by restating the arithmetic here would be the same bug twice.
 */
import { describe, it, expect } from "vitest";
import {
  gridTileTarget,
  VIEWER_BAR_HEIGHT,
  viewerStageBox,
  viewerTarget,
} from "../src/photos/render-target";

/** A 120-point square tile at 3x. */
const GRID = { tileSize: 120, devicePixelRatio: 3 };
const WINDOW = { width: 390, height: 844 };
/** A gesture bar and a status bar, as `useSafeAreaInsets` would report them. */
const INSETS = { top: 24, bottom: 34, left: 0, right: 0 };
/** The box the photograph gets, through the arithmetic the style sheet uses. */
const STAGE = viewerStageBox(WINDOW, INSETS);

const LANDSCAPE = { width: 4272, height: 2848 };
const PORTRAIT = { width: 2848, height: 4272 };
const PANORAMA = { width: 6000, height: 600 };

describe("what a square tile asks for", () => {
  it("covers a landscape's overflowing long edge", () => {
    // The centre crop spans the tile's 120 points on the short edge, so the long
    // edge is drawn at 180 points; at 3x that is 540 pixels, which snaps to 640.
    expect(gridTileTarget(LANDSCAPE, null, GRID)).toBe(640);
  });

  it("asks the same for a portrait as for a landscape of the same shape", () => {
    expect(gridTileTarget(PORTRAIT, null, GRID)).toBe(640);
    expect(gridTileTarget(LANDSCAPE, 6, GRID)).toBe(640);
  });

  it("asks for more for a panorama, whose crop shows a sliver of it", () => {
    expect(gridTileTarget(PANORAMA, null, GRID)!).toBeGreaterThan(
      gridTileTarget(LANDSCAPE, null, GRID)!,
    );
  });

  it("never asks for more than the source has", () => {
    // A small photograph blown up to a tile is still only worth its own pixels.
    // `measuredPhysicalLongEdge` caps at the source, and the snap then lands on
    // the rung that covers that.
    expect(gridTileTarget({ width: 200, height: 150 }, null, GRID)).toBe(320);
  });

  it("still resolves a photograph nobody has measured", () => {
    // Mid-backfill. The tile is the request's only input, which is what a
    // record with no dimensions gets measured against.
    expect(gridTileTarget(null, null, GRID)).toBe(640);
  });

  it("resolves nothing for a tile that has not been measured", () => {
    expect(gridTileTarget(LANDSCAPE, null, { ...GRID, tileSize: 0 })).toBeNull();
  });
});

describe("the box the viewer lays the photograph out in", () => {
  it("takes the system insets and both bars out of the window", () => {
    // The arithmetic itself, because it is the one number the style sheet and
    // the rendition request both read. A constant standing in for both halves
    // is what it replaced, and that constant was wrong by 40 to 90 points.
    expect(STAGE).toEqual({
      width: 390,
      height: 844 - 24 - 34 - 2 * VIEWER_BAR_HEIGHT,
    });
  });

  it("floors at zero rather than going negative", () => {
    // A window shorter than its own chrome is not a real device, but a stage of
    // negative height would resolve a target from a nonsense box rather than
    // refusing. `viewerTarget` reads zero as "no room", which is the honest
    // answer.
    const tiny = viewerStageBox({ width: 390, height: 100 }, INSETS, false);
    expect(tiny.height).toBe(0);
    expect(viewerTarget(tiny, LANDSCAPE, null, 3)).toBeNull();
  });

  it("gives a landscape window the whole window", () => {
    // A rotation is the one event that should resize the stage. Landscape hides
    // the system bars and the viewer's own, so nothing comes out of the window.
    const rotated = viewerStageBox({ width: 844, height: 390 }, INSETS);
    expect(rotated).toEqual({ width: 844, height: 390 });
  });
});

describe("what the viewer asks for", () => {
  it("asks for more than the tile does for the same photograph", () => {
    const tile = gridTileTarget(LANDSCAPE, null, GRID);
    const stage = viewerTarget(STAGE, LANDSCAPE, null, 3);

    // The assertion the plan names: the viewer's target exceeds the tile's for
    // the same record on the same device. It used to request nothing at all.
    expect(stage).toBeGreaterThan(tile!);
    // A 390x546 stage; a 3:2 photograph fits it on its width at 390 points, and
    // 390 at 3x is 1170 pixels — the 1280 rung.
    expect(stage).toBe(1280);
  });

  it("asks for a rung more for a portrait, which fills the stage's height", () => {
    // The reason the viewer's target is per record and not per screen. A
    // portrait photograph is drawn nearly twice as large on a phone as a
    // landscape one.
    expect(viewerTarget(STAGE, PORTRAIT, null, 3)).toBe(2560);
  });

  it("follows the orientation rather than the stored pair", () => {
    // The same bytes as LANDSCAPE, shown upright. It must ask what a portrait
    // asks, not what a landscape asks.
    expect(viewerTarget(STAGE, LANDSCAPE, 6, 3)).toBe(
      viewerTarget(STAGE, PORTRAIT, null, 3),
    );
  });

  it("resolves nothing for a stage with no room in it", () => {
    expect(viewerTarget({ width: 390, height: 0 }, LANDSCAPE, null, 3)).toBeNull();
    expect(viewerTarget({ width: 0, height: 546 }, LANDSCAPE, null, 3)).toBeNull();
  });

  it("still answers for a photograph nobody has measured", () => {
    // The viewer opens on a record mid-backfill like any other. The guessed
    // shape gives a target rather than nothing, which is what keeps the fetch
    // from being skipped for exactly the records that have had least done to
    // them.
    expect(viewerTarget(STAGE, null, null, 3)).not.toBeNull();
  });
});
