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
