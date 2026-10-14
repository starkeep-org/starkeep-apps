/**
 * How the Storage section names a sync-down ceiling.
 *
 * The words match admin-web's "Sync-down ceilings" on a desktop, so a ceiling
 * reads the same on every node: the category as the person knows it, the size
 * in the category's own unit, and which size is the library's canonical one.
 */

import type { StandInCategory } from "@starkeep/protocol-primitives";

export const CEILING_CATEGORY_LABELS: Readonly<Record<StandInCategory, string>> = {
  image: "Photos",
  video: "Videos",
};

/** Images are measured by long edge, video by bitrate. */
const FIDELITY_UNITS: Readonly<Record<StandInCategory, string>> = {
  image: "px",
  video: "kbps",
};

export function ceilingLabel(
  category: StandInCategory,
  ceiling: number | null,
  canonical: number,
): string {
  if (ceiling === null) return "None";
  const size = `${ceiling} ${FIDELITY_UNITS[category]}`;
  return ceiling === canonical ? `${size} (canonical)` : size;
}
