/**
 * Pure formatting helpers for the photo Info panel. Kept out of the component
 * so they're unit-testable without a DOM.
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMegapixels(width: number, height: number): string | null {
  if (width <= 0 || height <= 0) return null;
  return `${((width * height) / 1_000_000).toFixed(1)} MP`;
}

// EXIF orientation tag (274): 1–8. Values other than 1 indicate the stored
// pixels are rotated/flipped relative to how they should display.
const ORIENTATION_LABELS: Record<number, string> = {
  1: "Normal",
  2: "Mirrored",
  3: "Rotated 180°",
  4: "Mirrored, 180°",
  5: "Mirrored, 90° CCW",
  6: "Rotated 90° CW",
  7: "Mirrored, 90° CW",
  8: "Rotated 90° CCW",
};

export function formatOrientation(orientation: number): string {
  return ORIENTATION_LABELS[orientation] ?? `Unknown (${orientation})`;
}
