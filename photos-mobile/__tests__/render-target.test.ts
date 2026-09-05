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
  tileBox,
  VIEWER_FOOTER_HEIGHT,
  viewerStageBox,
  viewerTarget,
} from "../src/photos/render-target";

/** A 390-point phone at 3x, less the content padding `theme.ts` owns. */
const GRID = { targetRowHeight: 120, containerWidth: 350, devicePixelRatio: 3 };
const WINDOW = { width: 390, height: 844 };
/** A gesture bar and a status bar, as `useSafeAreaInsets` would report them. */
const INSETS = { top: 24, bottom: 34, left: 0, right: 0 };
/** The box the photograph gets, through the arithmetic the style sheet uses. */
const STAGE = viewerStageBox(WINDOW, INSETS);

const LANDSCAPE = { width: 4272, height: 2848 };
const PORTRAIT = { width: 2848, height: 4272 };
const PANORAMA = { width: 6000, height: 600 };

describe("the box a justified row assigns", () => {
  it("gives a photograph its own shape at the target row height", () => {
    const box = tileBox(LANDSCAPE, null, GRID);

    expect(box.height).toBeCloseTo(120, 6);
    expect(box.width).toBeCloseTo(180, 6);
  });

  it("caps a very wide photograph at the container rather than the row height", () => {
    // The case that makes the cap necessary. At 120 points a 10:1 photograph
    // would want 1200 points of width, which is three times the phone; measured
    // that way it would ask for the top of the ladder for a picture the layout
    // is about to draw 35 points tall.
    const box = tileBox(PANORAMA, null, GRID);

    expect(box.width).toBe(GRID.containerWidth);
    expect(box.height).toBeCloseTo(35, 6);
  });

  it("measures a quarter-turned photograph in the shape it is shown", () => {
    // `orientation: 6` rotates the picture, so the stored landscape pair is
    // displayed as a portrait. The box has to follow the display, or the layout
    // and the request both size the wrong axis.
    const upright = tileBox(LANDSCAPE, 6, GRID);

    expect(upright.height).toBeCloseTo(120, 6);
    expect(upright.width).toBeCloseTo(80, 6);
  });

  it("gives a photograph nobody has measured a plausible landscape box", () => {
    // Mid-backfill. The alternative is excluding the record, which gaps the
    // grid — and a wrong row-width estimate is not a crop.
    const box = tileBox(null, null, GRID);

    expect(box.width / box.height).toBeCloseTo(1.5, 6);
  });
});

describe("what a tile asks for", () => {
  it("snaps a landscape tile onto the 640 rung", () => {
    // 180x120 points, contained, is 180 points of long edge; at 3x that is 540
    // physical pixels, which snaps up to 640.
    expect(gridTileTarget(LANDSCAPE, null, GRID)).toBe(640);
  });

  it("asks for less for a portrait than for a landscape in the same row", () => {
    // 80x120 points is 120 of long edge and 360 pixels — the rung below. This is
    // the per-record part: one number for a whole page would have to be the
    // larger of the two for every tile.
    expect(gridTileTarget(PORTRAIT, null, GRID)).toBe(640);
    expect(gridTileTarget(LANDSCAPE, null, GRID)).toBe(640);
    // Both land on 640 at this row height, which is the honest result — the
    // difference in need is real and smaller than the gap between rungs. What
    // matters is that a panorama, whose need is a rung larger, is not dragged
    // down to theirs.
    expect(gridTileTarget(PANORAMA, null, GRID)).toBe(1280);
  });

  it("never asks for more than the source has", () => {
    // A small photograph blown up to a tile is still only worth its own pixels.
    // `measuredPhysicalLongEdge` caps at the source, and the snap then lands on
    // the rung that covers that.
    expect(gridTileTarget({ width: 200, height: 150 }, null, GRID)).toBe(320);
  });

  it("resolves nothing for a container that has not been measured", () => {
    expect(gridTileTarget(LANDSCAPE, null, { ...GRID, containerWidth: 0 })).toBeNull();
  });
});

describe("the box the viewer lays the photograph out in", () => {
  it("takes the system insets and the footer out of the window", () => {
    // The arithmetic itself, because it is the one number the style sheet and
    // the rendition request both read. A constant standing in for both halves
    // is what it replaced, and that constant was wrong by 40 to 90 points.
    expect(STAGE).toEqual({
      width: 390,
      height: 844 - 24 - 34 - VIEWER_FOOTER_HEIGHT,
    });
  });

  it("floors at zero rather than going negative", () => {
    // A window shorter than its own chrome is not a real device, but a stage of
    // negative height would resolve a target from a nonsense box rather than
    // refusing. `viewerTarget` reads zero as "no room", which is the honest
    // answer.
    const tiny = viewerStageBox({ width: 390, height: 100 }, INSETS);
    expect(tiny.height).toBe(0);
    expect(viewerTarget(tiny, LANDSCAPE, null, 3)).toBeNull();
  });

  it("gives a landscape window a wider, shorter stage", () => {
    // A rotation is the one event that should resize the stage, and this is what
    // it does to it.
    const rotated = viewerStageBox({ width: 844, height: 390 }, INSETS);
    expect(rotated.width).toBeGreaterThan(rotated.height);
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
