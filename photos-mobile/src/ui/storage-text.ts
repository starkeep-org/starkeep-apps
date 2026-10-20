/**
 * How Settings names what this device holds.
 *
 * Kept out of the screen component so it can be tested without a renderer.
 */

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
