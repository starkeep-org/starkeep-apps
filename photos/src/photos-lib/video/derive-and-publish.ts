/**
 * The call site that makes video derivation reachable.
 *
 * Probe, write the facts, derive the ladder, publish each rung, then assert
 * completeness. Every piece of this existed and was tested in isolation; none
 * of it was wired to anything, which meant a video could be imported and the
 * library would hold a record it could not lay out, thumbnail, or play.
 */

import { reportOriginalFidelity, type SignedFetch } from "../image-processing/publish-renditions";
import { existingRenditionClasses } from "../image-processing/publish-renditions";
import type { RenditionParent, PublishedRendition } from "../image-processing/publish-renditions";
import { deriveVideoLadder, videoLadderIsComplete, videoSourceOf } from "./derive-video-ladder";
import { publishVideoFacts, publishVideoRendition } from "./publish-video";
import { UnsupportedVideoError, type VideoTools } from "./video-tools";
import type { SizeClass, StandInSummaryLike } from "../ladder";
import { awaitsStamp, CANONICAL_VIDEO_CLASS, standInTargetOf, VIDEO_LADDER, videoFidelityKbps } from "../ladder";

export interface VideoIngestResult {
  readonly published: readonly PublishedRendition[];
  readonly failed: readonly { sizeClass: SizeClass; reason: string }[];
  readonly ladderComplete: boolean;
}

export interface VideoIngestDeps {
  readonly signedFetch: SignedFetch;
  readonly tools: VideoTools;
  /**
   * Content hash and storage key for a rendition's bytes.
   *
   * Supplied by the caller because the two servers address storage differently,
   * and this module has no business knowing which one it is running inside.
   */
  readonly keyFor: (
    bytes: Uint8Array,
    rendition: { readonly type: "image" | "video" },
  ) => Promise<{ contentHash: string; objectStorageKey: string }>;
  readonly enabledOptional?: readonly SizeClass[];
  /** Rungs whose bytes this node can serve; supplied by the local sweep. */
  readonly availableRenditionClasses?: readonly SizeClass[];
  /**
   * The platform's stand-in summary for the original. Its canonical target
   * decides the canonical transcode's bitrate and whether the smaller one
   * applies; omitted, the platform's default threshold does.
   */
  readonly standIns?: StandInSummaryLike | null;
}

/** The transcode that is an original's canonical stand-in. */
const CANONICAL_CLASS: SizeClass = CANONICAL_VIDEO_CLASS;

/**
 * Derive and publish everything a freshly imported video owes.
 *
 * Throws only when the *source* cannot be read at all — that is the terminal
 * `unsupported` signal the import ledger wants. Individual rungs that fail are
 * returned rather than thrown, because a clip with a poster and no transcode is
 * a clip the grid can still show, and discarding the poster over a failed
 * encode would leave a hole for a thumbnail that already exists.
 */
export async function deriveAndPublishVideo(
  path: string,
  parent: RenditionParent,
  deps: VideoIngestDeps,
): Promise<VideoIngestResult> {
  // What already exists, whoever made it: stand-ins by the platform's columns,
  // posters and skims by Photos' own label. A transcode another node already
  // made is reused rather than repeated — the platform keeps one per size.
  // See the stills path: an original the platform has not stamped yet has no
  // target, and a transcode made against the defaults is one it refuses.
  if (awaitsStamp(deps.standIns)) {
    return { published: [], failed: [], ladderComplete: false };
  }
  const target = standInTargetOf(deps.standIns);
  const recorded = deps.availableRenditionClasses
    ? [...deps.availableRenditionClasses]
    : await existingRenditionClasses(deps.signedFetch, parent.id);
  const existing = recorded;
  const missing = new Set<SizeClass>(
    VIDEO_LADDER.map((spec) => spec.sizeClass).filter((sizeClass) => !existing.includes(sizeClass)),
  );
  const result = await deriveVideoLadder(path, deps.tools, deps.enabledOptional ?? [], missing, target);

  // Facts first. They are what the grid lays a tile out with, and if publishing
  // is interrupted after this the record is at least coherent — dimensions and
  // duration with no renditions is a video that shows as a correctly-shaped
  // placeholder, whereas renditions with no facts is one the layout cannot
  // place at all.
  // A video's fidelity is its whole-container bitrate in kbps.
  const sourceFidelity = videoFidelityKbps(videoSourceOf(result.facts));
  await publishVideoFacts(deps.signedFetch, parent.id, result.facts);
  await reportOriginalFidelity(deps.signedFetch, parent.id, sourceFidelity);

  const published: PublishedRendition[] = [];
  const failed = result.failures.map((f) => ({ sizeClass: f.sizeClass, reason: f.reason }));

  for (const rendition of result.renditions) {
    try {
      const { contentHash, objectStorageKey } = await deps.keyFor(rendition.bytes, rendition);
      published.push(
        await publishVideoRendition(
          deps.signedFetch,
          // The probed bitrate is the original's fidelity, reported with
          // each stand-in, and the bitrate a canonical stand-in below the
          // threshold takes.
          { ...parent, sourceFidelity, canonicalTarget: target?.canonical ?? null },
          rendition,
          contentHash,
          objectStorageKey,
        ),
      );
    } catch (err) {
      // A publish failure is transient by nature (network, presign, a 5xx) and
      // is reported so the next sweep retries just this rung.
      failed.push({ sizeClass: rendition.sizeClass, reason: (err as Error).message });
    }
  }

  const ladderComplete = videoLadderIsComplete(
    result.facts,
    [...existing, ...published.map((p) => p.sizeClass)] as SizeClass[],
    deps.enabledOptional ?? [],
    target,
  );

  // Archiving is the platform's decision: once the canonical transcode reaches
  // the cloud, the platform tags the original itself.
  return { published, failed, ladderComplete };
}

/** Whether a derivation error means "never retry this file". */
export function isTerminalVideoError(err: unknown): boolean {
  return err instanceof UnsupportedVideoError;
}
