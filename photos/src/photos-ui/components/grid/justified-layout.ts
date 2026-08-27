/**
 * Justified row layout for the photo list.
 *
 * The list shows whole photos, not centre crops of a fixed square: every photo
 * in a row is scaled to the same height, so its own shape survives. A row of
 * photos scaled to a common height almost never adds up to exactly the width of
 * the container, so the row is closed as soon as it overflows and every photo in
 * it is then cropped horizontally by the *same fraction* of its own width until
 * the row fits exactly. Equal fractions rather than equal pixels: taking 20 px
 * off a 600 px panorama and off a 150 px portrait is the same edit only in the
 * arithmetic sense.
 *
 * The final row of a list has nothing to overflow into, so it is left
 * underfilled and uncropped rather than stretched — a short row is honest about
 * having run out of photos; a stretched one silently lies about the shapes.
 */

/**
 * The deepest crop a row is allowed to apply. Reached only by rows a single
 * very wide photo dominates, where filling the width at the requested height
 * would cut most of the photo away. Such a row is drawn shorter instead, which
 * costs one row of even height and saves the photo.
 */
const MIN_CROP_SCALE = 0.7;

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
   * is shown uncropped, which happens only to an underfilled final row.
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

  for (const item of items) {
    const aspect = aspectOf(item);
    current.push(item);
    naturalWidth += aspect * targetRowHeight;
    if (naturalWidth >= availableFor(current.length)) {
      rows.push(fitRow(current, aspectOf, availableFor(current.length), naturalWidth, targetRowHeight));
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
 * Crop an overflowing row down to exactly the available width.
 *
 * The row keeps the requested height as long as the crop stays within
 * MIN_CROP_SCALE; past that it trades height for a shallower crop.
 */
function fitRow<T>(
  items: readonly T[],
  aspectOf: (item: T) => number,
  available: number,
  naturalWidth: number,
  targetRowHeight: number,
): JustifiedRow<T> {
  const exactScale = available / naturalWidth;
  const cropScale = Math.max(exactScale, MIN_CROP_SCALE);
  const height = targetRowHeight * (exactScale / cropScale);
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
