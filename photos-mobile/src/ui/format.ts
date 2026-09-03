/**
 * Small, shared answers about a library item and its size.
 *
 * Their own module because the two components that need them import each other:
 * `LibraryGrid` renders the rows and opens `LibraryViewer`, and the viewer asks
 * the same two questions about the record it is showing. Leaving them on the
 * grid made the pair a require cycle, which React Native reports and which
 * "can result in uninitialized values" — a class of failure that shows up at
 * module-init time, not at the call site, and is correspondingly hard to read
 * when it does.
 */

import { typeCategory } from "@starkeep/protocol-primitives";
import type { LibraryItem } from "../library";

/**
 * Whether this record is a clip.
 *
 * The record's own type decides, not the media store's category: a Motion Photo
 * is an image record whose bytes carry a trailing MP4, and calling it a video
 * would put a duration badge on a photograph.
 */
export function isVideo(item: LibraryItem): boolean {
  return typeCategory(item.record.type) === "video";
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
