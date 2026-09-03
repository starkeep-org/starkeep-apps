import type { RenditionThresholdPolicy } from "./rendition-policy";
import { canonicalTarget } from "./rendition-policy";

export interface Dimensions {
  width: number;
  height: number;
}

export function normalizedDevicePixelRatio(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

export function orientationSwapsAxes(orientation: number | null | undefined): boolean {
  return orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
}

export function displayedDimensions(
  source: Dimensions,
  orientation: number | null | undefined,
): Dimensions {
  return orientationSwapsAxes(orientation)
    ? { width: source.height, height: source.width }
    : source;
}

function valid(dimensions: Dimensions): boolean {
  return dimensions.width > 0 && dimensions.height > 0;
}

/**
 * The shape a record is drawn in when nothing knows its real one.
 *
 * A mild landscape guess, which is wrong in the least disruptive way available:
 * it is a row-width estimate, not a crop, so a photograph whose dimensions have
 * not been read yet takes a plausible slot in a row rather than being excluded
 * from the grid. A library mid-backfill therefore renders rather than gapping.
 */
export const UNKNOWN_DISPLAY_ASPECT = 1.5;

/**
 * The width-over-height ratio a photograph is *shown* at.
 *
 * Displayed rather than stored, because the two differ for a quarter-turn EXIF
 * orientation and every layout works in the shape a viewer will see. Shared
 * because both grids lay out from this number: a phone and a browser that
 * disagreed about a photograph's shape would put it in differently sized boxes
 * and therefore request different rungs for it.
 */
export function displayedAspect(
  source: Dimensions | null | undefined,
  orientation: number | null | undefined,
): number {
  if (!source || !valid(source)) return UNKNOWN_DISPLAY_ASPECT;
  const displayed = displayedDimensions(source, orientation);
  return displayed.width / displayed.height;
}

export function coverRenderedLongEdge(source: Dimensions, container: Dimensions): number {
  if (!valid(source) || !valid(container)) return 0;
  const scale = Math.max(container.width / source.width, container.height / source.height);
  return Math.max(source.width, source.height) * scale;
}

export function containRenderedLongEdge(source: Dimensions, container: Dimensions): number {
  if (!valid(source) || !valid(container)) return 0;
  const scale = Math.min(container.width / source.width, container.height / source.height);
  return Math.max(source.width, source.height) * scale;
}

export interface MeasuredNeedOptions {
  source?: Dimensions | null;
  container: Dimensions;
  orientation?: number | null;
  fit: "cover" | "contain";
  devicePixelRatio?: number | null;
}

export function measuredPhysicalLongEdge(options: MeasuredNeedOptions): number | null {
  if (!valid(options.container)) return null;
  const source = options.source && valid(options.source)
    ? displayedDimensions(options.source, options.orientation)
    : null;
  const cssLongEdge = source
    ? options.fit === "cover"
      ? coverRenderedLongEdge(source, options.container)
      : containRenderedLongEdge(source, options.container)
    : Math.max(options.container.width, options.container.height);
  const raw = Math.ceil(cssLongEdge * normalizedDevicePixelRatio(options.devicePixelRatio));
  if (raw <= 0) return null;
  const sourceLongEdge = source ? Math.max(source.width, source.height) : null;
  return sourceLongEdge ? Math.min(raw, sourceLongEdge) : raw;
}

export function canonicalMeasuredTarget(
  policy: RenditionThresholdPolicy,
  requiredLongEdge: number | null,
): number | null {
  return requiredLongEdge === null ? null : canonicalTarget(policy, requiredLongEdge);
}
