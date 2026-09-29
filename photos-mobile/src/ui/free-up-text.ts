import type { FreeUpSpaceReport } from "@starkeep/sync-engine";
import { formatBytes } from "./format";

/**
 * What one "Free up space" did, in a sentence.
 *
 * Kept out of the screen component so it can be tested without a renderer, as
 * `verify-text.ts` is. The refusals are stated as a reason rather than left as
 * a shortfall: a file kept because the cloud could not be shown to hold it is
 * the pass working, not failing, and a bare "freed 0 B" reads as a broken
 * button.
 */
export function describeFreed(report: FreeUpSpaceReport): string {
  if (report.removed.length === 0 && report.refused.length === 0) {
    return "Nothing here can be removed: every photo is either at a size this device keeps, or taken on this device.";
  }
  const verb = report.dryRun ? "Would free" : "Freed";
  const freed = `${verb} ${formatBytes(report.freedBytes)} from ${report.removed.length} file(s)`;
  if (report.refused.length === 0) return `${freed}.`;
  return `${freed}; kept ${report.refused.length} that the cloud could not yet be shown to hold.`;
}

const CATEGORY_NOUNS: Readonly<Record<string, string>> = {
  image: "Photo",
  video: "Video",
  audio: "Audio",
};

/**
 * A resident-set group as the Storage section names it: a stand-in group is
 * the previews of a category, an original group is its full-size files, and
 * `kept` is everything no preview can stand in for.
 */
export function describeStorageGroup(group: string): string {
  if (group === "kept") return "Other files, kept on every device";
  const [kind, category] = group.split(":");
  const noun = (category && CATEGORY_NOUNS[category]) ?? category ?? group;
  if (kind === "stand-in") return `${noun} previews`;
  if (kind === "original") return `${noun} originals`;
  return group;
}
