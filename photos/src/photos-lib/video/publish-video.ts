/**
 * Publishing a video's probed facts and derived renditions.
 *
 * The facts go on the shared record, because duration, codec and capture time
 * are what the file *is* and every app granted video sees them. The renditions
 * go through the still path's publisher onto Photos' own plane, because a
 * poster and a 720p transcode are derived copies of one app's making.
 *
 * The differences video used to force — a poster registering as an `image`
 * record and a transcode as a `video` one, and their dimensions landing in two
 * different metadata tables — went away with the records. A rung is a row now.
 */

import {
  publishRendition,
  RenditionPublishError,
  type PublishedRendition,
  type RenditionParent,
  type SignedFetch,
} from "../image-processing/publish-renditions";
import type { DerivedVideoRendition } from "./derive-video-ladder";
import type { VideoFacts } from "./probe";

/**
 * Write what the container said into the record's `video` metadata columns.
 *
 * Not best-effort. Duration and dimensions are what the grid lays a tile out
 * with and what the ladder's maxima are compared against on any later sweep — a
 * video record with neither is one the library cannot reason about at all.
 *
 * Nulls are omitted rather than written. A column left absent means "not known";
 * a column written as null asserts the container was asked and said nothing,
 * which is a different and usually false claim.
 */
export async function publishVideoFacts(
  signedFetch: SignedFetch,
  recordId: string,
  facts: VideoFacts,
): Promise<void> {
  const metadata: Record<string, string | number> = {
    width: facts.width,
    height: facts.height,
    duration_ms: facts.durationMs,
  };
  if (facts.frameRate !== null) metadata.frame_rate = facts.frameRate;
  if (facts.videoCodec !== null) metadata.video_codec = facts.videoCodec;
  if (facts.audioCodec !== null) metadata.audio_codec = facts.audioCodec;
  if (facts.bitrate !== null) metadata.bitrate = facts.bitrate;
  if (facts.capturedAt !== null) metadata.captured_at = facts.capturedAt;

  const res = await signedFetch(`/data/records/${recordId}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ typeId: "video", metadata }),
  });
  if (!res.ok) {
    throw new RenditionPublishError(
      "register",
      "video-facts",
      res.status,
      await res.text().catch(() => ""),
    );
  }
}

/**
 * Publish one derived video rendition.
 *
 * The still path's function, unchanged, with the video's own bytes handed to
 * it. Two things that used to differ no longer can: a poster registered as an
 * `image` record and a transcode as a `video` one, and each wrote its
 * dimensions into whichever metadata table its type had. A rendition is no
 * longer a record of any type — it is a row in Photos' own table with `width`
 * and `height` columns — so the distinction has nothing left to express.
 *
 * What the move costs, stated rather than hidden: a transcode's duration is no
 * longer written anywhere. It went into the child record's `video` metadata and
 * nothing read it; the parent's duration is what the viewer and the ladder use.
 */
export async function publishVideoRendition(
  signedFetch: SignedFetch,
  parent: RenditionParent,
  rendition: DerivedVideoRendition,
  contentHash: string,
  retainLocal = false,
): Promise<PublishedRendition> {
  return publishRendition(
    signedFetch,
    parent,
    {
      sizeClass: rendition.sizeClass,
      contentType: rendition.contentType,
      width: rendition.width,
      height: rendition.height,
      data: rendition.bytes,
    },
    contentHash, retainLocal,
  );
}
