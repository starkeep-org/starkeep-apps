/**
 * A video's posters, made on the phone that recorded it.
 *
 * ## Why the phone makes them
 *
 * A poster used to come only from a desktop's derivation sweep, which has to
 * download the whole original and run ffmpeg to extract one frame. For a 391 MB
 * clip that is minutes of transfer and encoding before any other device can
 * show the video as anything but a placeholder. The phone holds the original
 * already, and one keyframe decode plus two small JPEG encodes cost it a few
 * hundred milliseconds. So the phone makes both poster rungs, at import, and
 * the desktop's sweep finds them present and makes only the transcodes.
 *
 * ## The same posters any node would make
 *
 * Each poster is the desktop's record shape exactly (`publish-video.ts` in
 * Photos): an `image/jpeg` child of the video, the `photos/derived` label naming
 * its rung, its dimensions as metadata, and the shared file name. The frame
 * time and the size rules come from `@starkeep/photos-ladder`, so a poster
 * shows the same moment at the same size whichever node made it. Only the
 * encoder differs, and a poster is a picture of the video, not a stand-in for
 * it, so nothing reads its bytes as evidence about the original's.
 *
 * Also here: the container facts the same native call reads, which is how a
 * video gets its `captured_at` from its own bytes instead of waiting for a
 * desktop's ffprobe to put it in its place in the library.
 */

import {
  createDataRecord,
  dataRecordObjectKey,
  typeCategory,
  type DataRecord,
  type HLCClock,
  type MetadataRow,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import {
  applicableVideoClasses,
  posterTimestamp,
  videoRenditionFileName,
  type SizeClass,
  type VideoClassSpec,
} from "@starkeep/photos-ladder";
import type { MediaAliasStore } from "../media/media-alias";
import { PHOTOS_APP_ID } from "./renditions";

/**
 * JPEG quality for a phone-made poster.
 *
 * 81, set by the person reviewing the output: a poster is a placeholder for a
 * video, seen at tile size or for a moment before playback, and the bytes above
 * this buy nothing anyone looks at.
 */
export const POSTER_JPEG_QUALITY = 81;

/** The type every poster registers as. See `publish-video.ts` in Photos. */
export const POSTER_TYPE = "image/jpeg";

/** Photos' label naming a derived rung. Must match `PHOTOS_LABEL_KEYS.derived`. */
export const DERIVED_LABEL_KEY = "derived";

/** What a video's container says about it, read natively from its bytes. */
export interface VideoContainerFacts {
  readonly durationMs: number;
  /** Display size: the stored size turned by the container's rotation. Sizes the posters. */
  readonly width: number;
  readonly height: number;
  /** The container's recording date as ISO UTC, or null when it holds none. */
  readonly capturedAt: string | null;
}

export type ReadVideoFacts = (uri: string) => Promise<VideoContainerFacts>;

/** Decode one frame of `uri` at `timeUs` and write it as a JPEG at each long edge. */
export type ExtractPosters = (
  uri: string,
  timeUs: number,
  outputs: ReadonlyArray<{ readonly maxLongEdge: number; readonly path: string }>,
  quality: number,
) => Promise<ReadonlyArray<{ readonly path: string; readonly width: number; readonly height: number }>>;

export interface VideoPosterDeps {
  readonly database: DatabaseAdapter;
  readonly objectStorage: ObjectStorageAdapter;
  readonly clock: HLCClock;
  readonly hash: (bytes: Uint8Array) => Promise<string>;
  readonly userId: () => string;
  readonly readFacts: ReadVideoFacts;
  readonly extractPosters: ExtractPosters;
  /** A scratch path for one poster's JPEG before it is stored. */
  readonly scratchPath: (name: string) => string;
  readonly readScratch: (path: string) => Uint8Array;
  readonly removeScratch: (path: string) => void;
  readonly originAppId?: string;
  /** Charge the bytes to residency, as derived stills are. */
  readonly noteDerived?: (record: DataRecord) => Promise<void>;
}

/** The poster rungs a video of this long edge takes, by the ladder's rule. */
export function posterClassesFor(longEdge: number): VideoClassSpec[] {
  return applicableVideoClasses({
    longEdge,
    bitrate: Number.POSITIVE_INFINITY,
    durationSeconds: 0,
  }).filter((spec) => spec.kind === "poster");
}

/** The rung a derived child names in its file name, or null when it is not a poster. */
function posterClassOf(child: DataRecord): SizeClass | null {
  const name = child.originalFilename ?? "";
  for (const spec of posterClassesFor(Number.POSITIVE_INFINITY)) {
    if (name.startsWith(`${spec.sizeClass}_`)) return spec.sizeClass;
  }
  return null;
}

/**
 * Write a video's `captured_at` from its container when its metadata row lacks
 * one. Returns whether anything was written.
 *
 * The rule `writeMediaMetadata` states holds here: a column is written only
 * from the file's bytes. The container's date is in the file; the media store's
 * `DATE_TAKEN` is not. Dimensions are left alone: import already records the
 * stored size, which is what the desktop's probe writes too.
 */
export async function writeVideoFacts(
  database: DatabaseAdapter,
  recordId: StarkeepId,
  type: string,
  facts: VideoContainerFacts,
  existing: MetadataRow | undefined,
): Promise<boolean> {
  if (!facts.capturedAt || existing?.["captured_at"] != null) return false;
  await database.putMetadata(type, { recordId, captured_at: facts.capturedAt });
  return true;
}

/**
 * Make and store the posters `parent` lacks. Returns how many were written.
 *
 * Bytes first, then the record, then its label and dimensions, so no sync round
 * ever carries a poster record whose bytes this node does not hold.
 */
export async function publishVideoPosters(
  deps: VideoPosterDeps,
  parent: DataRecord,
  uri: string,
  facts: VideoContainerFacts,
  have: ReadonlySet<SizeClass> = new Set(),
): Promise<number> {
  const longEdge = Math.max(facts.width, facts.height);
  if (longEdge <= 0) return 0;
  const wanted = posterClassesFor(longEdge).filter((spec) => !have.has(spec.sizeClass));
  if (wanted.length === 0) return 0;

  const outputs = wanted.map((spec) => ({
    maxLongEdge: spec.maxLongEdge,
    path: deps.scratchPath(`${parent.id}-${spec.sizeClass}.jpg`),
  }));
  const timeUs = Math.round(posterTimestamp(facts.durationMs / 1000) * 1_000_000);
  const made = await deps.extractPosters(uri, timeUs, outputs, POSTER_JPEG_QUALITY);

  let written = 0;
  try {
    for (const [index, spec] of wanted.entries()) {
      const output = made[index];
      if (!output) continue;
      const bytes = deps.readScratch(output.path);
      const contentHash = await deps.hash(bytes);
      const objectStorageKey = dataRecordObjectKey(deps.userId(), POSTER_TYPE, contentHash);
      await deps.objectStorage.put(objectStorageKey, bytes, { contentType: POSTER_TYPE });

      const record = createDataRecord(
        {
          type: POSTER_TYPE,
          originAppId: deps.originAppId ?? PHOTOS_APP_ID,
          contentHash,
          objectStorageKey,
          sizeBytes: bytes.byteLength,
          mimeType: POSTER_TYPE,
          parentId: parent.id,
          originalFilename: videoRenditionFileName(parent.originalFilename, spec.sizeClass, "poster"),
        },
        deps.clock,
      );
      await deps.database.put(record);
      await deps.database.upsertLabels([
        {
          recordId: record.id,
          appId: PHOTOS_APP_ID,
          key: DERIVED_LABEL_KEY,
          value: spec.sizeClass,
          recordType: POSTER_TYPE,
          hlc: deps.clock.now(),
        },
      ]);
      await deps.database.putMetadata(POSTER_TYPE, {
        recordId: record.id,
        width: output.width,
        height: output.height,
      });
      await deps.noteDerived?.(record);
      written += 1;
    }
  } finally {
    for (const output of made) {
      try {
        deps.removeScratch(output.path);
      } catch {
        // A leftover scratch file costs a few kilobytes of cache; failing the
        // posters over it would cost the posters.
      }
    }
  }
  console.log(
    `[posters] ${parent.originalFilename ?? parent.id}: ${written} poster(s) at ${timeUs} us ` +
      `(${wanted.map((s) => s.sizeClass).join(", ")})`,
  );
  return written;
}

export interface VideoPosterBackfillOutcome {
  readonly scanned: number;
  readonly written: number;
  readonly complete: boolean;
  readonly resumeAfter: string | null;
}

/**
 * Give posters and container facts to videos imported before this device made
 * them, one alias page at a time.
 *
 * Same walk as `backfillImageExif`: the alias table names every asset this
 * device imported, and a video among them is a record this device can read.
 * A video that already has both posters and both facts costs one query.
 */
export async function backfillVideoPosters(
  deps: VideoPosterDeps & { readonly aliases: MediaAliasStore },
  options: { readonly limit: number; readonly after?: string | null },
): Promise<VideoPosterBackfillOutcome> {
  const page = deps.aliases.listAfter(options.after ?? null, options.limit);
  if (page.length === 0) return { scanned: 0, written: 0, complete: true, resumeAfter: null };

  const ids = page.map((alias) => alias.recordId as StarkeepId);
  const found = await deps.database.query({
    filters: [{ field: "id", operator: "in", value: ids }],
    limit: ids.length,
  });
  const videos = new Map(
    found.records
      .filter((r) => !r.deletedAt && typeCategory(r.type) === "video")
      .map((r) => [r.id, r] as const),
  );

  let written = 0;
  let scanned = 0;
  if (videos.size > 0) {
    const children = await deps.database.query({
      filters: [{ field: "parentId", operator: "in", value: [...videos.keys()] }],
      limit: videos.size * 16,
    });
    const have = new Map<string, Set<SizeClass>>();
    for (const child of children.records) {
      if (child.deletedAt || !child.parentId) continue;
      const sizeClass = posterClassOf(child);
      if (!sizeClass) continue;
      const set = have.get(child.parentId) ?? new Set<SizeClass>();
      set.add(sizeClass);
      have.set(child.parentId, set);
    }
    const metadata = await deps.database.getMetadataByIds("video", [...videos.keys()]);

    for (const alias of page) {
      const video = videos.get(alias.recordId as StarkeepId);
      if (!video) continue;
      const row = metadata.get(video.id);
      const posters = have.get(video.id) ?? new Set<SizeClass>();
      const needsFacts = row?.["captured_at"] == null;
      const needsPosters = posterClassesFor(Number.POSITIVE_INFINITY).some(
        (spec) => !posters.has(spec.sizeClass),
      );
      if (!needsFacts && !needsPosters) continue;

      scanned += 1;
      try {
        const facts = await deps.readFacts(alias.contentUri);
        if (needsFacts) await writeVideoFacts(deps.database, video.id, video.type, facts, row);
        if (needsPosters) written += await publishVideoPosters(deps, video, alias.contentUri, facts, posters);
      } catch (err) {
        // One clip the retriever cannot open costs that clip's posters, not the
        // pass. The desktop's sweep still makes them from the original.
        console.warn(`[posters] ${video.originalFilename ?? video.id}: ${String(err)}`);
      }
    }
  }

  const complete = page.length < options.limit;
  return {
    scanned,
    written,
    complete,
    resumeAfter: complete ? null : page[page.length - 1]!.objectStorageKey,
  };
}
