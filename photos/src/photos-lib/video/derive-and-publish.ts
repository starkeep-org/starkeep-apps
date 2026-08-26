/**
 * The call site that makes video derivation reachable.
 *
 * Probe, write the facts, derive the ladder, publish each rung, then assert
 * completeness. Every piece of this existed and was tested in isolation; none
 * of it was wired to anything, which meant a video could be imported and the
 * library would hold a record it could not lay out, thumbnail, or play.
 */

import { assertLadderComplete, type SignedFetch } from "../image-processing/publish-renditions";
import { existingRenditionClasses } from "../image-processing/publish-renditions";
import type { RenditionParent, PublishedRendition } from "../image-processing/publish-renditions";
import { deriveVideoLadder, videoLadderIsComplete } from "./derive-video-ladder";
import { publishVideoFacts, publishVideoRendition } from "./publish-video";
import { UnsupportedVideoError, type VideoTools } from "./video-tools";
import type { SizeClass } from "../ladder";
import { VIDEO_LADDER } from "../ladder";

export interface VideoIngestResult {
  readonly published: readonly PublishedRendition[];
  readonly failed: readonly { sizeClass: SizeClass; reason: string }[];
  readonly ladderComplete: boolean;
  readonly archiveTagged: boolean;
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
}

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
  // A label alone is not a usable rendition. Candidate resolution drops a
  // child without dimensions, so counting one here could archive the original
  // while every reader remains unable to select its replacement. Re-deriving
  // such a child is safe: record registration deduplicates by parent and hash,
  // then the metadata write repairs the existing record.
  const existing = deps.availableRenditionClasses
    ? [...deps.availableRenditionClasses]
    : await existingRenditionClasses(deps.signedFetch, parent.id, {
        requireDimensions: true,
      });
  const missing = new Set<SizeClass>(
    VIDEO_LADDER.map((spec) => spec.sizeClass)
      .filter((sizeClass) => !existing.includes(sizeClass)),
  );
  const result = await deriveVideoLadder(path, deps.tools, deps.enabledOptional ?? [], missing);

  // Facts first. They are what the grid lays a tile out with, and if publishing
  // is interrupted after this the record is at least coherent — dimensions and
  // duration with no renditions is a video that shows as a correctly-shaped
  // placeholder, whereas renditions with no facts is one the layout cannot
  // place at all.
  await publishVideoFacts(deps.signedFetch, parent.id, result.facts);

  const published: PublishedRendition[] = [];
  const failed = result.failures.map((f) => ({ sizeClass: f.sizeClass, reason: f.reason }));

  for (const rendition of result.renditions) {
    try {
      const { contentHash, objectStorageKey } = await deps.keyFor(rendition.bytes, rendition);
      published.push(
        await publishVideoRendition(
          deps.signedFetch,
          parent,
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
  );

  // The gate is only worth asking when the ladder is actually complete. Claiming
  // completeness with a rung missing is how an original gets frozen behind a
  // 48-hour thaw while the thing that would be read instead does not exist.
  let archiveTagged = false;
  if (ladderComplete) {
    archiveTagged = (await assertLadderComplete(deps.signedFetch, parent.id)).tagged;
  }

  return { published, failed, ladderComplete, archiveTagged };
}

/** Whether a derivation error means "never retry this file". */
export function isTerminalVideoError(err: unknown): boolean {
  return err instanceof UnsupportedVideoError;
}
