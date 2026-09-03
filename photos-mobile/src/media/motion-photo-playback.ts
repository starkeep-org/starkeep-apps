/**
 * Playing the video inside a Motion Photo, and keeping nothing afterwards.
 *
 * ## The decision this file implements
 *
 * **A Motion Photo is one image record, and the motion is a property of the
 * bytes that record already holds.** The clip is never stored beside it: no
 * second record, no second blob, no persistent cache and no budget line. The
 * photograph on this device costs exactly what a still costs, because the video
 * was always inside the JPEG.
 *
 * The one thing that argument cannot avoid is the player. ExoPlayer opens a URI
 * and will not take an in-memory buffer, so the extracted MP4 has to exist as a
 * file for as long as playback runs. It goes to the OS cache directory and is
 * deleted when the viewer closes — a scratch file rather than a cache, because
 * it is not a second copy of anything. Releasing it costs the next viewing one
 * read; holding it would make a Motion Photo cost twice what it does.
 *
 * ## Why the desktop's model is declined rather than deferred
 *
 * `starkeep-apps/photos` pairs an iOS Live Photo's two files at import and makes
 * the clip a child record labelled `photos/live-photo`. That is the right answer
 * to *its* problem: iOS genuinely writes two files, so the pair already exists
 * and the label is what records that they belong together.
 *
 * An Android Motion Photo is one file. Minting the extracted clip as a child
 * record would make the motion half real user data that syncs — and would store
 * the video **twice on the device that took it**, once inside the JPEG and once
 * beside it. Two formats with the same name are two different problems, and this
 * is not the desktop's.
 *
 * ## Why nulls are ordinary here
 *
 * Most JPEGs are not Motion Photos. Every step below can answer null and none of
 * them is a failure: a viewer that treated absence as an error would report
 * every normal photograph as broken.
 */

import { typeCategory, type DataRecord } from "@starkeep/protocol-primitives";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";
import type { ExpoFile, ExpoFileSystem } from "../storage/expo-object-storage";
import { isContentUri, streamFromFile } from "../storage/expo-object-storage";
import { extractMotionPhotoVideo, findMotionPhotoVideo } from "./motion-photo";
import type { MotionIndexStore } from "./motion-index";
import type { MediaAliasStore } from "./media-alias";

/**
 * The largest still this will read whole to look for motion.
 *
 * The same ceiling and the same reason as the import loop's: a `content://`
 * asset cannot be ranged, so looking inside one means holding it, and a ceiling
 * whose only job is to prevent an OOM must not itself be one. A still above this
 * is not a Motion Photo in any camera's output.
 */
export const MAX_MOTION_SCAN_BYTES = 64 * 1024 * 1024;

/** Where scratch clips live, relative to the OS cache directory. */
export const MOTION_SCRATCH_SEGMENTS = ["starkeep", "motion"] as const;

export interface MotionPhotoDeps {
  readonly fs: ExpoFileSystem;
  readonly index: MotionIndexStore;
  readonly objectStorage: ObjectStorageAdapter;
  /**
   * The alias table, so a record's import time can be compared with the index's
   * marker.
   *
   * Null on a node that reads no camera roll, which makes every record
   * uncovered — the safe direction, since the cost of being wrong that way is
   * one read and the cost of being wrong the other way is a Motion Photo that
   * never plays.
   */
  readonly aliases: MediaAliasStore | null;
  /** Where a scratch clip may be written. `cachePath` at the app's edge. */
  readonly cachePath: (...segments: string[]) => string;
}

/** A clip materialised for one viewing, and the call that takes it away again. */
export interface OpenMotionPhoto {
  readonly uri: string;
  /**
   * Where the still sits within the clip, in microseconds, when the XMP said.
   *
   * The frame the camera chose as *the photograph*. A viewer that starts at zero
   * is visibly on the wrong frame on a Pixel.
   */
  readonly presentationTimestampUs: number | null;
  release: () => void;
}

/**
 * The embedded clip as a file a player can open, or null.
 *
 * Null at every step is ordinary: the record is not an image, the index says
 * there is no motion, the bytes are not on this device, or the XMP described an
 * offset the bytes do not bear out.
 */
export async function openMotionPhoto(
  deps: MotionPhotoDeps,
  record: DataRecord,
): Promise<OpenMotionPhoto | null> {
  const key = record.objectStorageKey;
  if (!key) return null;
  // Before anything touches a file. The viewer asks this of everything it opens,
  // and the fallback scan reads the whole record — so without this guard opening
  // a 47 MB clip would pull it entirely into the JS heap to look for XMP that
  // only ever appears in a JPEG. Same rule the import-time scan applies, and for
  // the same reason: the format is Google's and it is defined over JPEG.
  if (!isMotionCandidate(record)) return null;

  const found = await locateMotion(deps, record, key);
  if (!found) return null;

  const bytes = await readForExtraction(deps, key, found.offset, found.length);
  if (!bytes) return null;

  // Re-validated rather than trusted. `extractMotionPhotoVideo` checks the
  // `ftyp` box, because XMP is written by cameras and is wrong often enough to
  // matter — and an offset that is plausible but wrong yields bytes that fail
  // much later, inside a decoder, with a message about the wrong thing.
  const clip =
    bytes.whole !== null
      ? extractMotionPhotoVideo(bytes.whole)
      : validatedSlice(bytes.slice!);
  if (!clip) return null;

  const file = deps.fs.file(deps.cachePath(...MOTION_SCRATCH_SEGMENTS, `${scratchName(key)}.mp4`));
  file.create({ intermediates: true, overwrite: true });
  file.write(clip);

  return {
    uri: file.uri,
    presentationTimestampUs: found.presentationTimestampUs ?? null,
    release: () => {
      try {
        file.delete();
      } catch {
        // Already gone, because the OS reclaimed the cache directory or a
        // previous release ran. Both are the outcome this wanted.
      }
    },
  };
}

/**
 * Whether these bytes could carry motion at all, from the record alone.
 *
 * A video, a HEIC, a PNG and a raw file all answer no, and answering from the
 * type costs nothing where answering from the bytes costs a whole read.
 */
function isMotionCandidate(record: DataRecord): boolean {
  if (typeCategory(record.type) !== "image") return false;
  if (record.type === "image/jpeg") return true;
  return /\.jpe?g$/i.test(record.originalFilename ?? "");
}

/**
 * Delete scratch clips a previous run of this process left behind.
 *
 * A viewer killed mid-playback runs no `release()`, and this sweep is the only
 * thing that will ever collect that file. One pass over a directory that should
 * normally be empty is the whole of the cleanup, so it runs at node start-up
 * where it costs nothing and cannot be forgotten.
 */
export function sweepMotionScratch(deps: {
  readonly fs: ExpoFileSystem;
  readonly cachePath: (...segments: string[]) => string;
}): void {
  try {
    const directory = deps.fs.directory(deps.cachePath(...MOTION_SCRATCH_SEGMENTS));
    if (!directory.exists) return;
    directory.delete();
  } catch {
    // A cache directory that cannot be cleared is not a reason to fail a node
    // start-up. The OS reclaims it on its own schedule, which is the whole
    // reason these bytes live there.
  }
}

/**
 * Where the clip is, asking the index first and the bytes only when it must.
 *
 * ## When the bytes get read
 *
 * Only for a record nothing has ever looked inside, which after this ships means
 * only records imported before the index existed and records whose bytes arrived
 * by sync. Import scans every JPEG it reads, so the ordinary case costs one row
 * lookup and no I/O at all — see `motion-index.ts` for what makes the *absence*
 * of a row an answer.
 *
 * A scan that finds nothing writes a negative row, so an old photograph costs
 * that read once rather than once per opening.
 */
async function locateMotion(
  deps: MotionPhotoDeps,
  record: DataRecord,
  key: string,
): Promise<ReturnType<typeof findMotionPhotoVideo>> {
  if (deps.index.scanned(key)) return deps.index.get(key);
  if (coveredByImport(deps, record, key)) return null;

  const bytes = await readWhole(deps, key);
  if (!bytes) return null;
  const found = findMotionPhotoVideo(bytes);
  deps.index.record(key, found);
  return found;
}

/**
 * Whether import already looked inside this record's bytes and said nothing.
 *
 * True when this node imported the record at or after the moment it started
 * indexing motion. Anything else — a record imported before that, or one that
 * arrived by sync and was therefore never imported here at all — is unknown, and
 * unknown is what the fallback scan is for.
 */
function coveredByImport(deps: MotionPhotoDeps, record: DataRecord, key: string): boolean {
  const from = deps.index.scannedFrom();
  if (from === null) return false;
  const alias = deps.aliases?.get(key) ?? null;
  if (!alias || alias.recordId !== record.id) return false;
  return alias.addedAtMs >= from;
}

/** The whole file, for a scan that has to find the offsets itself. */
async function readWhole(deps: MotionPhotoDeps, key: string): Promise<Uint8Array | null> {
  const file = fileFor(deps, key);
  if (!file || file.size === null || file.size > MAX_MOTION_SCAN_BYTES) return null;
  return collect(streamFromFile(file));
}

/**
 * The clip's bytes, ranged where ranging is possible.
 *
 * A `file://` blob takes a ranged read over the offsets the index already holds,
 * which reads the clip and not the photograph. A `content://` asset cannot be
 * ranged at all — `openHandle` has no `ContentProviderFile` branch — so it
 * materialises whole, which is the same read import already performs, and the
 * caller re-derives the offsets from the buffer it got.
 */
async function readForExtraction(
  deps: MotionPhotoDeps,
  key: string,
  offset: number,
  length: number,
): Promise<{ whole: Uint8Array | null; slice: Uint8Array | null } | null> {
  const file = fileFor(deps, key);
  if (!file) return null;

  if (isContentUri(file.uri)) {
    if (file.size === null || file.size > MAX_MOTION_SCAN_BYTES) return null;
    const whole = await collect(streamFromFile(file));
    return whole ? { whole, slice: null } : null;
  }

  if (offset < 0 || length <= 0) return null;
  const slice = await collect(
    streamFromFile(file, { start: offset, end: offset + length - 1 }),
  );
  return slice && slice.byteLength === length ? { whole: null, slice } : null;
}

/**
 * A slice already positioned at the clip, checked for an `ftyp` box.
 *
 * The same validation `extractMotionPhotoVideo` performs, applied to a read that
 * started at the offset rather than to a whole file. The check is the point:
 * without it a wrong offset produces a file no player opens, and the failure
 * surfaces far from the cause.
 */
function validatedSlice(slice: Uint8Array): Uint8Array | null {
  if (slice.byteLength < 12) return null;
  const isFtyp =
    slice[4] === 0x66 && slice[5] === 0x74 && slice[6] === 0x79 && slice[7] === 0x70;
  return isFtyp ? slice : null;
}

/** A file for these bytes, wherever the overlay says they are. */
function fileFor(deps: MotionPhotoDeps, key: string): ExpoFile | null {
  const uri = deps.objectStorage.localFileUriFor?.(key) ?? null;
  if (!uri) return null;
  const file = deps.fs.file(uri);
  return file.exists ? file : null;
}

/**
 * A name for the scratch file, from the content-addressed key.
 *
 * The key carries slashes, so it cannot be a filename. Taking the last segment
 * is enough: it is the content hash, which is what makes two viewings of the
 * same photograph name the same file and two different photographs name
 * different ones.
 */
function scratchName(key: string): string {
  return key.split("/").filter(Boolean).pop() ?? "clip";
}

/** A stream, whole. Bounded by the caller. */
async function collect(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!stream) return null;
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
