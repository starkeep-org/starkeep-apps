/**
 * Justified row layout for the photo list.
 *
 * The list shows whole photos, not centre crops of a fixed square: every photo
 * in a row is scaled to the same height, so its own shape survives. A row of
 * photos at a common height almost never adds up to exactly the width of the
 * container, and closing that gap is what the rest of this file is about.
 *
 * There are two ways to close it, and a row uses both:
 *
 *  - Crop. Every photo in the row loses the same *fraction* of its own width.
 *    Equal fractions rather than equal pixels: taking 20 px off a 600 px
 *    panorama and off a 150 px portrait is the same edit only in the arithmetic
 *    sense. Cropping can only narrow a row, so it answers overflow alone.
 *  - Height. Scaling the whole row up or down changes its width in proportion
 *    and costs no photo anything, but it makes the row a different size from
 *    its neighbours.
 *
 * Crop is spent first, up to a small budget, because a few per cent off the
 * sides is invisible where a row half again as tall as the one above it is not.
 * Past that budget the height takes over.
 *
 * The final row of a list has nothing to overflow into, so it is left
 * underfilled and uncropped at the requested height rather than stretched — a
 * short row is honest about having run out of photos; a stretched one silently
 * lies about the shapes.
 */

/**
 * The most any photo may lose to the crop under normal circumstances: a tenth
 * of its width, split between its two sides.
 *
 * This used to be 30%, which is not a crop budget so much as a licence. It hurt
 * worst exactly where rows are shortest — two photos across a phone — because
 * a row that can only be two or three photos long has very coarse choices, and
 * the greedy rule below had to take whichever one it stumbled into. Two
 * ordinary 3:2 photos across a 390 px phone fill 0.715 of the width, so each
 * lost 28.5% of itself and the guard never fired.
 */
const MIN_CROP_SCALE = 0.9;

/**
 * There is deliberately no floor on how short a row may be driven. A 10:1
 * panorama across a 390 px phone *is* 39 px tall — that is not a degenerate
 * row, it is what a 10:1 photo looks like at that width, and the only way to
 * make it taller is to stop showing most of it. The crop cap above is therefore
 * absolute: no photo loses more than a tenth of itself, whatever its shape.
 */

export interface JustifiedPlacement<T> {
  item: T;
  /** Displayed (post-crop) width in CSS pixels. */
  width: number;
}

export interface JustifiedRow<T> {
  placements: Array<JustifiedPlacement<T>>;
  /** Displayed height in CSS pixels; equal for every photo in the row. */
  height: number;
  /**
   * Fraction of each photo's own width that survives the crop. 1 means the row
   * is shown whole, which is the common case now that height does most of the
   * work.
   */
  cropScale: number;
}

export interface JustifiedLayoutOptions {
  /** Content width the rows must fill, in CSS pixels. */
  containerWidth: number;
  /** Requested row height in CSS pixels. */
  targetRowHeight: number;
  /** Horizontal and vertical space between photos, in CSS pixels. */
  gap: number;
}

/**
 * How far a row sits from filling the container on its own terms: the factor
 * its width has to be multiplied by, one way or the other. Above 1 the row is
 * short and wants to grow; below 1 it overflows and wants to give something up.
 */
type FillRatio = number;

/**
 * How much a row is being asked to bend, on a scale where growing by a third
 * and shrinking to three quarters are comparable. Used only to choose between
 * two candidate rows, so its absolute value means nothing.
 */
function strain(fill: FillRatio): number {
  return Math.abs(Math.log(fill));
}

/**
 * Lay items out into justified rows.
 *
 * `aspectOf` returns each item's *displayed* width/height ratio — already
 * corrected for EXIF orientation, since the layout works in the shapes a viewer
 * will see rather than the shapes the bytes are stored in.
 */
export function justifiedRows<T>(
  items: readonly T[],
  aspectOf: (item: T) => number,
  { containerWidth, targetRowHeight, gap }: JustifiedLayoutOptions,
): Array<JustifiedRow<T>> {
  if (containerWidth <= 0 || targetRowHeight <= 0 || items.length === 0) return [];

  const rows: Array<JustifiedRow<T>> = [];
  let current: T[] = [];
  let naturalWidth = 0;

  const availableFor = (count: number) => containerWidth - gap * Math.max(0, count - 1);
  const fillFor = (count: number, width: number) => availableFor(count) / width;

  for (const item of items) {
    const withItem = naturalWidth + aspectOf(item) * targetRowHeight;
    const fillWith = fillFor(current.length + 1, withItem);

    // Still short of the container: the row can hold more.
    if (fillWith >= 1) {
      current.push(item);
      naturalWidth = withItem;
      continue;
    }

    // Adding this photo overflows the row, so the row ends either side of it.
    // Ending before it leaves a row that has to grow to fill the width; ending
    // after it leaves one that has to give width up. Take whichever bends less
    // — this is the choice the old greedy rule never made, and the reason two
    // photos across a phone were cropped so hard.
    const fillWithout = current.length > 0 ? fillFor(current.length, naturalWidth) : Infinity;
    if (strain(fillWithout) <= strain(fillWith)) {
      rows.push(fitRow(current, aspectOf, fillWithout, targetRowHeight, availableFor(current.length)));
      current = [item];
      naturalWidth = aspectOf(item) * targetRowHeight;
    } else {
      current.push(item);
      rows.push(fitRow(current, aspectOf, fillWith, targetRowHeight, availableFor(current.length)));
      current = [];
      naturalWidth = 0;
    }
  }

  if (current.length > 0) {
    rows.push(underfilledRow(current, aspectOf, targetRowHeight));
  }
  return rows;
}

/**
 * Turn a row's fill ratio into the height and crop that meet it exactly.
 *
 * Height and crop multiply out to the fill ratio by construction, so the row
 * lands on the container's width whichever way the work is divided between
 * them.
 */
function fitRow<T>(
  items: readonly T[],
  aspectOf: (item: T) => number,
  fill: FillRatio,
  targetRowHeight: number,
  available: number,
): JustifiedRow<T> {
  // A short row can only grow, since cropping would take it further from the
  // width it is trying to reach. An overflowing one spends the crop budget
  // first and takes the remainder out of its height.
  const heightScale = fill >= 1 ? fill : Math.min(1, fill / MIN_CROP_SCALE);
  const cropScale = fill / heightScale;
  const height = targetRowHeight * heightScale;
  return {
    placements: distribute(items, items.map((item) => aspectOf(item) * height * cropScale), available),
    height,
    cropScale,
  };
}

function underfilledRow<T>(
  items: readonly T[],
  aspectOf: (item: T) => number,
  targetRowHeight: number,
): JustifiedRow<T> {
  return {
    placements: items.map((item) => ({ item, width: aspectOf(item) * targetRowHeight })),
    height: targetRowHeight,
    cropScale: 1,
  };
}

/**
 * Round widths to whole pixels and give the last photo whatever pixel or two
 * the rounding lost, so the row's edge lands on the container's edge rather
 * than a fraction short of it.
 */
function distribute<T>(
  items: readonly T[],
  widths: readonly number[],
  available: number,
): Array<JustifiedPlacement<T>> {
  const rounded = widths.map((width) => Math.max(1, Math.round(width)));
  const residual = available - rounded.reduce((sum, width) => sum + width, 0);
  const last = rounded.length - 1;
  rounded[last] = Math.max(1, rounded[last] + residual);
  return items.map((item, index) => ({ item, width: rounded[index] }));
}
