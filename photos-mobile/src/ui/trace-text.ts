/**
 * One sync round as a line of the Work section.
 *
 * The full record goes into "Share diagnostics" (`formatSyncTrace`). On the
 * screen a person needs four things per round: when, why it ran, what moved
 * in each direction, and — on the last round of a sync — how the sync ended.
 */

import type { SyncTraceRound } from "../work/sync-trace";
import { formatBytes } from "./format";

/** Rounds the Work section shows. */
export const TRACE_ROUNDS_SHOWN = 8;

const TRIGGER_LABELS: Record<SyncTraceRound["trigger"], string> = {
  open: "app opened",
  "after-import": "after import",
  "after-derive": "after new sizes",
  timer: "every 30 s",
  "media-change": "new photo",
  button: "Sync now",
  background: "background",
};

export function describeTraceRound(round: SyncTraceRound): string {
  const time = new Date(round.endedAt).toLocaleTimeString();
  const parts = [`${time} · ${TRIGGER_LABELS[round.trigger] ?? round.trigger}`];
  if (round.round > 0) {
    parts.push(
      `↑ ${round.shipped} row${round.shipped === 1 ? "" : "s"}` +
        (round.uploaded > 0 ? `, ${round.uploaded} file${round.uploaded === 1 ? "" : "s"} ${formatBytes(round.uploadedBytes)}` : ""),
    );
    parts.push(
      `↓ ${round.applied} row${round.applied === 1 ? "" : "s"}` +
        (round.landed > 0 ? `, ${round.landed} file${round.landed === 1 ? "" : "s"} ${formatBytes(round.landedBytes)}` : ""),
    );
    if (round.blocked) parts.push("something could not transfer");
  }
  if (round.stopReason !== null) parts.push(round.stopReason);
  return parts.join(" · ");
}
