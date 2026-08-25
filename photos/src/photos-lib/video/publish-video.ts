/**
 * Publishing a video's probed facts and derived renditions.
 *
 * Mirrors the still path (`publish-renditions.ts`) deliberately — same presign →
 * PUT → register → metadata sequence, same `photos/rendition` label, same
 * "renditions are shared child records" decision. The differences are the ones
 * video actually forces, and each is called out where it happens.
 */

import { PHOTOS_LABEL_KEYS } from "../labels";
import {
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
 * Two things differ from the still path, both forced by video:
 *
 * - **A poster registers as `image`, the rest as `video`.** The poster is
 *   genuinely a still, it is what the grid paints, and registering it as video
 *   would hide it from every image-granted app — a library with holes where the
 *   clips are.
 * - **The metadata `typeId` follows the record's type**, so a poster's
 *   dimensions land in the image columns and a transcode's in the video ones.
 *   Sending the wrong one writes into a table the record does not have a row in.
 */
export async function publishVideoRendition(
  signedFetch: SignedFetch,
  parent: RenditionParent,
  rendition: DerivedVideoRendition,
  contentHash: string,
  objectStorageKey: string,
): Promise<PublishedRendition> {
  const presignRes = await signedFetch(`/files/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: objectStorageKey,
      contentType: rendition.contentType,
      // Every rung is `instant` — renditions are what the library is read from
      // once originals go cold. Only the original is ever `archive`.
      intent: "instant",
    }),
  });
  if (!presignRes.ok) {
    throw new RenditionPublishError(
      "presign",
      rendition.sizeClass,
      presignRes.status,
      await presignRes.text().catch(() => ""),
    );
  }
  const presign = (await presignRes.json()) as {
    url: string;
    checksumSha256?: string;
    storageClass?: string;
    tagging?: Record<string, string>;
  };

  const uploadRes = await fetch(presign.url, {
    method: "PUT",
    headers: {
      "Content-Type": rendition.contentType,
      // Mandatory when present — they are inside the signature, so dropping one
      // fails the request rather than uploading something unverified.
      ...(presign.checksumSha256 ? { "x-amz-checksum-sha256": presign.checksumSha256 } : {}),
      ...(presign.storageClass ? { "x-amz-storage-class": presign.storageClass } : {}),
      ...(presign.tagging && Object.keys(presign.tagging).length > 0
        ? {
            "x-amz-tagging": Object.entries(presign.tagging)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&"),
          }
        : {}),
    },
    body: new Uint8Array(rendition.bytes),
  });
  if (!uploadRes.ok) {
    throw new RenditionPublishError(
      "upload",
      rendition.sizeClass,
      uploadRes.status,
      uploadRes.statusText,
    );
  }

  const createRes = await signedFetch(`/data/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: rendition.type === "image" ? "image/jpeg" : "video/mp4",
      fileName: renditionFileName(parent.originalFilename, rendition.sizeClass, rendition.type),
      contentType: rendition.contentType,
      contentHash,
      sizeBytes: rendition.bytes.byteLength,
      parentId: parent.id,
      labels: [{ key: PHOTOS_LABEL_KEYS.rendition, value: rendition.sizeClass }],
    }),
  });
  if (!createRes.ok) {
    throw new RenditionPublishError(
      "register",
      rendition.sizeClass,
      createRes.status,
      await createRes.text().catch(() => ""),
    );
  }
  const { record } = (await createRes.json()) as { record: { id: string } };

  // Same reasoning as the still path: variant resolution orders by long edge,
  // so a rendition without dimensions cannot be ordered and is excluded
  // entirely. This is part of publication, not best-effort. Returning success
  // here would let the archive gate count an unreadable child as a completed
  // rung.
  const metaRes = await signedFetch(`/data/records/${record.id}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      typeId: rendition.type,
      metadata: {
        width: rendition.width,
        height: rendition.height,
        ...(rendition.type === "video" && rendition.durationMs !== undefined
          ? { duration_ms: rendition.durationMs }
          : {}),
      },
    }),
  });
  if (!metaRes.ok) {
    throw new RenditionPublishError(
      "metadata",
      rendition.sizeClass,
      metaRes.status,
      await metaRes.text().catch(() => ""),
    );
  }

  return {
    sizeClass: rendition.sizeClass,
    recordId: record.id,
    contentHash,
    sizeBytes: rendition.bytes.byteLength,
  };
}

function renditionFileName(
  originalFilename: string | null,
  sizeClass: string,
  type: "image" | "video",
): string {
  const base = originalFilename ?? "video";
  // The extension has to match what was actually produced: a poster named
  // `.mov` is a JPEG that half the world will refuse to open.
  const stripped = base.replace(/\.[^.]+$/, "");
  return `${sizeClass}_${stripped}${type === "image" ? ".jpg" : ".mp4"}`;
}
