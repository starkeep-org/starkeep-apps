/**
 * Deriving and publishing a record's ladder — the one implementation every
 * caller uses.
 *
 * Three callers need this: the Next server's `/api/resize` route, the cloud
 * resize Lambda, and (from Phase 2) the local derivation worker. They were
 * previously two near-identical copies of a multi-step flow, which is exactly
 * the kind of duplication that gets fixed in one place and not the other.
 *
 * ## The order is the design
 *
 * 1. **Ask what is missing before doing any work.** The old shape derived the
 *    entire ladder and *then* filtered out the rungs that already existed, so
 *    re-running against a complete record cost a full twenty-nine seconds to
 *    publish nothing. Asking first turns that into two small queries and no
 *    decode at all — which is why {@link loadSource} is a callback rather than
 *    a buffer: a record with nothing to do never downloads its original.
 *
 * 2. **The ThumbHash and the record's own metadata go first.** The ThumbHash is
 *    a ~25-byte, zero-request placeholder, and it used to be written after every
 *    rung had been published — the cheapest thing in the app gated behind the
 *    most expensive path in it. Dimensions and EXIF ride the same write because
 *    the decode that produces them is already paid.
 *
 * 3. **Rungs publish as they are encoded, ascending.** A caller waiting for the
 *    whole ladder waits about sixty times longer than the tile it is painting
 *    needs.
 *
 * ## Why the metadata write is not incidental
 *
 * Without `captured_at`, a record falls back to its `created_at` for display
 * ordering — so a library imported through the folder watcher files itself
 * entirely under its import date and then silently reorders as the user opens
 * photos one at a time and a lazy backfill fills the gaps in. Writing it here,
 * from the decode that was happening anyway, is what stops that.
 */

import { createHash } from "node:crypto";
import {
  CHEAP_STILL_CLASSES,
  applicableStillClasses,
  classForTargetLongEdge,
  type SizeClass,
} from "../ladder";
import { extractExif } from "../metadata/exif-reader";
import { UndecodableError } from "./decode-errors";
import {
  computePerceptualHash,
  computeThumbHash,
  decodeForDerivation,
  deriveStillLadderStream,
  ladderIsComplete,
  type DeriveLadderOptions,
} from "./derive-ladder";
import type { DerivationAttempt, AttemptOutcome } from "./derivation-attempts";
import { recordAttempt } from "./derivation-attempts";
import type { PlatformDecoder } from "./platform-decoder";
import {
  assertLadderComplete,
  existingRenditionClasses,
  publishRendition,
  publishThumbHash,
  type PublishedRendition,
  type SignedFetch,
} from "./publish-renditions";

/** Where a node keeps its own verdicts about records it could not decode. */
export interface DerivationAttemptStore {
  read(recordId: string): Promise<DerivationAttempt | null>;
  write(attempt: DerivationAttempt): Promise<void>;
}

export interface DeriveAndPublishParams {
  readonly signedFetch: SignedFetch;
  readonly parent: {
    readonly id: string;
    readonly originalFilename: string | null;
    readonly mimeType: string | null;
  };
  /**
   * Fetches the original's bytes. Called at most once, and only when there is
   * work that needs them — a record whose ladder and metadata are already
   * complete never touches its original at all.
   */
  readonly loadSource: () => Promise<Uint8Array>;
  /**
   * The pixel size the caller wants covered. Expanded to the rung that answers
   * it plus {@link CHEAP_STILL_CLASSES}, which the decode makes nearly free.
   * Omit for the whole applicable ladder.
   */
  readonly targetLongEdge?: number;
  readonly codec?: DeriveLadderOptions["codec"];
  /** Supplied on nodes that have one; HEIC is undecodable without it. */
  readonly platformDecoder?: PlatformDecoder;
  /** Node-local; omitted by callers that have nowhere to keep verdicts. */
  readonly attempts?: DerivationAttemptStore;
}

export interface DeriveAndPublishResult {
  readonly outcome: AttemptOutcome | "publish-failed";
  readonly published: PublishedRendition[];
  /** Which classes were already present and therefore skipped. */
  readonly skipped: SizeClass[];
  readonly archiveGate: { tagged: boolean; refusals: string[] } | null;
  /** Free text for logs and error responses. */
  readonly detail?: string;
}

/** What `include=metadata` gives back for an image record. */
interface ParentMetadata {
  width?: number | null;
  height?: number | null;
  thumb_hash?: string | null;
}

export async function deriveAndPublish(
  params: DeriveAndPublishParams,
): Promise<DeriveAndPublishResult> {
  const { signedFetch, parent } = params;

  // A node that has already decided it cannot read this format says so without
  // downloading the file again. This is what keeps a sweeper off an entire HEIC
  // library rather than re-failing on every record of it, daily, forever.
  const priorAttempt = (await params.attempts?.read(parent.id)) ?? null;
  if (priorAttempt?.outcome === "undecodable-here") {
    return {
      outcome: "undecodable-here",
      published: [],
      skipped: [],
      archiveGate: null,
      detail: priorAttempt.detail ?? "this node cannot decode this format",
    };
  }

  const [already, metadata] = await Promise.all([
    existingRenditionClasses(signedFetch, parent.id),
    readParentMetadata(signedFetch, parent.id),
  ]);
  const wanted = requestedClasses(params.targetLongEdge);

  // Dimensions on the parent are what let this answer "is there anything to
  // do?" without a decode. A record that has never been derived has none, so
  // the first pass always does the work; every pass after it is two queries.
  const storedLongEdge = Math.max(metadata?.width ?? 0, metadata?.height ?? 0);
  const metadataComplete = storedLongEdge > 0 && Boolean(metadata?.thumb_hash);
  const missing = metadataComplete
    ? applicableStillClasses(storedLongEdge)
        .map((s) => s.sizeClass)
        .filter((c) => !already.includes(c) && wanted.has(c))
    : null;

  if (missing !== null && missing.length === 0) {
    // Nothing to derive. The gate is still asserted, because a previous run may
    // have published the last rung and then failed to assert — and leaving an
    // original hot is cheap while leaving it un-archivable is permanent.
    return {
      outcome: "complete",
      published: [],
      skipped: [...already] as SizeClass[],
      archiveGate: await gateIfComplete(signedFetch, parent.id, storedLongEdge, already),
    };
  }

  const sourceBytes = await params.loadSource();

  let decoded;
  try {
    decoded = await decodeForDerivation(sourceBytes, {
      ...(parent.mimeType ? { sourceType: parent.mimeType } : {}),
      ...(params.platformDecoder ? { platformDecoder: params.platformDecoder } : {}),
    });
  } catch (err) {
    const permanent = err instanceof UndecodableError;
    const outcome: AttemptOutcome = permanent ? "undecodable-here" : "transient-failure";
    await noteAttempt(params, priorAttempt, outcome, (err as Error).message);
    return {
      outcome,
      published: [],
      skipped: [],
      archiveGate: null,
      detail: (err as Error).message,
    };
  }

  // Step 2: the placeholder and the record's own facts, before any rung. Both
  // come out of the decode that just happened, so the only thing standing
  // between a cold library and a legible grid is one metadata write.
  await writeParentFacts(signedFetch, parent.id, decoded, sourceBytes, metadata);

  const toDerive = applicableStillClasses(decoded.source.longEdge)
    .map((s) => s.sizeClass)
    .filter((c) => !already.includes(c) && wanted.has(c));

  const published: PublishedRendition[] = [];
  try {
    for await (const rendition of deriveStillLadderStream(decoded, {
      only: toDerive,
      ...(params.codec ? { codec: params.codec } : {}),
    })) {
      const contentHash = createHash("sha256").update(rendition.data).digest("hex");
      published.push(
        await publishRendition(
          signedFetch,
          { id: parent.id, originalFilename: parent.originalFilename },
          rendition,
          contentHash,
          dataRecordObjectKey("image", contentHash),
        ),
      );
    }
  } catch (err) {
    // Partial success is the honest outcome: the rungs already published are
    // real and useful, and re-running finishes the rest. Failing the whole
    // request would throw away work that succeeded.
    await noteAttempt(params, priorAttempt, "transient-failure", (err as Error).message);
    return {
      outcome: "publish-failed",
      published,
      skipped: already.filter((c) => wanted.has(c as SizeClass)) as SizeClass[],
      archiveGate: null,
      detail: (err as Error).message,
    };
  }

  const finalClasses = await existingRenditionClasses(signedFetch, parent.id);
  await noteAttempt(params, priorAttempt, "complete");
  return {
    outcome: "complete",
    published,
    skipped: already.filter((c) => wanted.has(c as SizeClass)) as SizeClass[],
    archiveGate: await gateIfComplete(
      signedFetch,
      parent.id,
      decoded.source.longEdge,
      finalClasses,
    ),
  };
}

/**
 * Which classes a caller asked for.
 *
 * A bare target expands to the rung that answers it plus the cheap ones, per
 * the rule that an on-demand call derives what was asked for and anything else
 * that is free once the source is decoded. No target means the whole ladder.
 */
function requestedClasses(targetLongEdge: number | undefined): Set<SizeClass> {
  if (targetLongEdge === undefined) {
    return new Set(applicableStillClasses(Number.MAX_SAFE_INTEGER).map((s) => s.sizeClass));
  }
  return new Set<SizeClass>([classForTargetLongEdge(targetLongEdge), ...CHEAP_STILL_CLASSES]);
}

/**
 * The placeholder, the dimensions and the EXIF, in one write.
 *
 * Only the fields the record is actually missing are sent. The metadata write
 * is a column-wise upsert, so sending a field overwrites it — and re-deriving a
 * record should not quietly restate facts somebody may have corrected since.
 */
async function writeParentFacts(
  signedFetch: SignedFetch,
  parentId: string,
  decoded: Awaited<ReturnType<typeof decodeForDerivation>>,
  sourceBytes: Uint8Array,
  existing: ParentMetadata | null,
): Promise<void> {
  const facts: Record<string, unknown> = {};

  if (!(existing?.width && existing?.height)) {
    facts.width = decoded.source.width;
    facts.height = decoded.source.height;
  }

  // Read from the *original* bytes, not from the decoded working image: the
  // working image is raw pixels and carries no EXIF at all.
  if (!existing?.width) {
    const exif = await extractExif(sourceBytes);
    const mapped: Record<string, unknown> = {
      captured_at: exif.dateTakenRaw,
      camera_make: exif.cameraMake,
      camera_model: exif.cameraModel,
      f_number: exif.fNumber,
      exposure_time: exif.exposureTime,
      iso: exif.iso,
      lens_model: exif.lensModel,
      gps_lat: exif.gpsLat,
      gps_lon: exif.gpsLon,
      orientation: exif.orientation,
    };
    for (const [key, value] of Object.entries(mapped)) {
      if (value !== null && value !== undefined) facts[key] = value;
    }
  }

  if (Object.keys(facts).length > 0) {
    const res = await signedFetch(`/data/records/${parentId}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typeId: "image", metadata: facts }),
    });
    if (!res.ok) {
      console.warn(
        `[derive] metadata write failed for ${parentId} (${res.status}) — ` +
          `this record will sort by its import date until repaired`,
      );
    }
  }

  if (!existing?.thumb_hash) {
    await publishThumbHash(
      signedFetch,
      parentId,
      await computeThumbHash(decoded),
      await computePerceptualHash(decoded),
    );
  }
}

async function readParentMetadata(
  signedFetch: SignedFetch,
  parentId: string,
): Promise<ParentMetadata | null> {
  const res = await signedFetch(`/data/records/${parentId}/metadata/image`);
  if (!res.ok) return null;
  const { metadata } = (await res.json()) as { metadata: ParentMetadata | null };
  return metadata;
}

/**
 * Assert the archive gate, but only when every applicable rung genuinely
 * exists.
 *
 * The platform trusts this claim — that is the point of the split — so making
 * it loosely is the one way an app could freeze an original with nothing
 * readable in its place.
 */
async function gateIfComplete(
  signedFetch: SignedFetch,
  parentId: string,
  sourceLongEdge: number,
  classes: readonly string[],
): Promise<{ tagged: boolean; refusals: string[] } | null> {
  if (sourceLongEdge <= 0) return null;
  if (!ladderIsComplete(sourceLongEdge, classes)) return null;
  return assertLadderComplete(signedFetch, parentId);
}

async function noteAttempt(
  params: DeriveAndPublishParams,
  previous: DerivationAttempt | null,
  outcome: AttemptOutcome,
  detail?: string,
): Promise<void> {
  if (!params.attempts) return;
  await params.attempts.write(
    recordAttempt(previous, params.parent.id, outcome, Date.now(), detail),
  );
}

function dataRecordObjectKey(typeId: string, contentHash: string): string {
  return `shared/${typeId}/${contentHash.slice(0, 2)}/${contentHash}`;
}
