/**
 * How many pixels a measured container actually needs — re-exported from the
 * package every Photos surface shares.
 *
 * Moved out to `@starkeep/photos-ladder` alongside `rendition-policy.ts`,
 * because the two are one rule: measure the box, correct for orientation, scale
 * by the device pixel ratio, snap to a rung. The phone was computing that with
 * its own arithmetic over a fixed three-column grid, which is a second
 * implementation of the same rule and therefore a rendering difference visible
 * on one device class only.
 *
 * It qualifies for the package on the package's own terms: pure arithmetic over
 * numbers, no I/O, no DOM, no React. Nothing here knows what a container *is* —
 * a caller measures one and passes two numbers.
 *
 * This file stays as the name every call site in this app already imports, so
 * the extraction is invisible from here.
 */

export {
  canonicalMeasuredTarget,
  containRenderedLongEdge,
  coverRenderedLongEdge,
  displayedAspect,
  displayedDimensions,
  measuredPhysicalLongEdge,
  normalizedDevicePixelRatio,
  orientationSwapsAxes,
  UNKNOWN_DISPLAY_ASPECT,
  type Dimensions,
  type MeasuredNeedOptions,
} from "@starkeep/photos-ladder";
