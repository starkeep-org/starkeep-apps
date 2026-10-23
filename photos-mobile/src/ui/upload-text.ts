/**
 * The one line Settings shows about uploads.
 *
 * The uploader runs beside the syncs, so "Sync now" finishing says nothing
 * about the files. This line says how many are still to go, whether they are
 * moving, and how many this phone can no longer send because their bytes left
 * the camera roll.
 */

import type { UploaderStats } from "@starkeep/sync-engine";
import { formatBytes } from "./format";

/** The status line, or null when there is nothing to say. */
export function describeUploads(stats: UploaderStats | null): string | null {
  if (stats === null) return null;
  const count = stats.queued.fast.count + stats.queued.full.count;
  const bytes = stats.queued.fast.bytes + stats.queued.full.bytes;
  const parts: string[] = [];
  if (count > 0) {
    const files = `${count} ${count === 1 ? "file" : "files"} (${formatBytes(bytes)})`;
    parts.push(
      stats.state === "paused"
        ? `Waiting for the network to upload ${files}`
        : stats.state === "stopped"
          ? `${files} to upload on Wi-Fi`
          : `Uploading ${files}`,
    );
  }
  if (stats.blocked.count > 0) {
    parts.push(`${stats.blocked.count} missing from the camera roll`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
