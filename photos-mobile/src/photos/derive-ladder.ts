/**
 * The phone making its own renditions.
 *
 * ## What this removes
 *
 * A photograph taken on this device used to depend on another node to become
 * viewable. The original sat in the camera roll, sync carried it to the cloud, a
 * machine running `sharp` derived the ladder, and the rungs came back — so until
 * that round trip completed, every surface on the device that owns the
 * photograph painted either a placeholder or a full-resolution decode of a
 * 12-megapixel file. This is what makes the phone the node that answers for its
 * own camera roll.
 *
 * ## What it will not do
 *
 * **Nothing above `image-medium`.** See {@link MOBILE_DERIVE_CEILING_LONG_EDGE}.
 *
 * **Nothing to the archive gate.** A record whose original exceeds the ceiling
 * still has missing rungs, so `ladderIsComplete` stays false and the original
 * stays out of deep archive until a node running `sharp` finishes the ladder.
 * That safety falls out of the existing rule rather than being asserted here,
 * and this pass deliberately adds no assertion of its own.
 *
 * **Nothing to a video.** A poster is a frame extraction and a skim is a
 * transcode; neither is an AVIF encode of a decoded still, so neither belongs in
 * this pass.
 *
 * ## Why the walk is the alias table's
 *
 * The population is *the originals whose bytes are on this device*, and that set
 * is the alias table — the same argument `backfillThumbHashes` makes, and the
 * same walk. It also needs no media-store query: the alias carries the
 * `content://` URI the decoder opens.
 *
 * A record that arrived by sync is deliberately outside the walk. Its bytes are
 * usually not here, and where they are, the node that already holds the original
 * is the node that should pay for the decode.
 *
 * ## The one native call, and why it is injected
 *
 * Encoding an AVIF is the only thing here a phone cannot do in JavaScript.
 * {@link ImageEncoder} is the seam: everything above it — which rungs a record
 * is missing, what they are called, where their bytes land, what gets written
 * about them — is ordinary TypeScript that runs in Node against a fake encoder.
 * The same rule `ThumbHashEncoder` follows, for the same reason.
 */

import {
  createDataRecord,
  dataRecordObjectKey,
  typeCategory,
  type DataRecord,
  type HLCClock,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { loadVariantCandidatesForPage } from "@starkeep/storage-adapter";
import {
  applicableStillClasses,
  renditionFileName,
  renditionLongEdge,
  STILL_LADDER,
  type StillClassSpec,
} from "@starkeep/photos-ladder";
import type { MediaAliasStore } from "../media/media-alias";
import type { ScanCursorStore } from "../work/scan-cursor";
import { PHOTOS_APP_ID, PHOTOS_RENDITION_KEY } from "./renditions";

/**
 * The largest rung this device will produce.
 *
 * `image-medium` — the rung on-device models read, the viewer's first stage, and
 * the share and export default. Above it are 2560 and 4272, which are a real CPU
 * cost for pixels a phone screen cannot show, and they remain the work of a node
 * running `sharp`.
 *
 * Expressed as a long edge read off the ladder rather than as a literal or a
 * list of class names, so respecifying the ladder carries the ceiling with it.
 * Deliberately **not** `CHEAP_STILL_CLASSES`: that constant is the Lambda's
 * inline tier and stops at 640, and reusing it here would silently drop
 * `image-medium` — a different number for a different reason.
 */
export const MOBILE_DERIVE_CEILING_LONG_EDGE: number = STILL_LADDER.find(
  (spec) => spec.sizeClass === "image-medium",
)!.maxLongEdge;

/** What a rendition is encoded as here, matching every other node. */
const RENDITION_TYPE = "image/avif";

/**
 * How many records one sweep decodes before it stops.
 *
 * Four, against the ThumbHash backfill's twelve, and the ratio is roughly what
 * the two passes cost: that one decodes a photograph and encodes 25 bytes, and
 * this one decodes a photograph and then runs up to three AVIF encodes over it.
 * `derive-ladder-cheap` budgets ten seconds for one record's cheap tier, so four
 * records is a window's worth of work — and a sweep that stops early resumes
 * from its cursor rather than from the beginning.
 *
 * Reasoned rather than measured. The measurement wants a handset; see the plan's
 * list of what remains unmeasured.
 */
export const DERIVE_RECORD_BUDGET = 4;

/**
 * How many aliases one page of the walk reads.
 *
 * **Deliberately much larger than {@link DERIVE_RECORD_BUDGET}, and the gap is
 * the point.** The two numbers bound different costs. A record that already has
 * every rung this device makes costs nothing but its share of two batched reads,
 * and a library that has been derived is almost entirely such records — so a
 * page sized to the decode budget would make the sweep re-read the whole alias
 * table four rows at a time to discover there was nothing to do.
 *
 * Sixty-four keeps the two reads per page amortised while staying well inside
 * what one `IN (…)` and one `getMetadataByIds` should be asked to carry.
 */
export const DERIVE_PAGE_LIMIT = 64;

/**
 * How many pages one sweep walks before it stops, derived or not.
 *
 * The third bound, and the one that only matters once a library *is* derived.
 * The record budget stops a sweep that is finding work; nothing stops a sweep
 * that is finding none, and on a phone whose sixty thousand photographs all have
 * their rungs that is a walk of the whole alias table on every app open — a few
 * thousand queries to establish that there was nothing to do.
 *
 * Thirty-two pages is two thousand aliases, so a fully derived library of that
 * size is re-checked across about thirty app opens rather than on each one. The
 * cursor is what makes that a rotation rather than a repetition: each sweep
 * starts where the last one stopped, so every record is still reached.
 *
 * The same trade `MAX_EXIF_BACKFILL_PASSES` makes, and for the same reason: a
 * repair pass that costs the same whether or not there is anything to repair is
 * a cost the app pays forever.
 */
export const DERIVE_PAGE_BUDGET = 32;

/** One encoded rung: the bytes, and what they actually came out as. */
export interface EncodedRendition {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * A source decoded once, ready to be encoded at several sizes.
 *
 * The decode is the expensive half and every rung reads the same pixels, so it
 * is paid once per record and reused down the ladder — the argument
 * `derive-ladder.ts` makes on the `sharp` side, where the same shape is called
 * `DecodedImage`.
 *
 * It carries no dimensions, deliberately. A decoded reference reports its size
 * in *logical* units scaled by the device's display density, which is not the
 * pixel count anything here reasons about; the ladder is computed from the
 * record's stored dimensions and the true output size comes back from
 * {@link encode}.
 */
export interface DecodedSource {
  /**
   * Encode at no more than `maxLongEdge`, at this quality.
   *
   * Never upscales — a source already inside `maxLongEdge` is encoded at its own
   * size, which is rule 1 of the ladder.
   */
  encode(maxLongEdge: number, quality: number): Promise<EncodedRendition>;
  /** Let the decoded bitmap go. Called once per record, however the pass ends. */
  release(): void;
}

/**
 * Decode whatever is at this URI, at no more than `maxLongEdge`.
 *
 * Null for anything this device cannot read — a RAW file, a corrupt JPEG, an
 * asset the media store has since lost. Null rather than a throw because an
 * undecodable photograph is an ordinary member of a camera roll and must cost
 * one record's turn rather than the pass.
 */
export type ImageEncoder = (
  uri: string,
  maxLongEdge: number,
) => Promise<DecodedSource | null>;

/** SHA-256 over a whole buffer, supplied by the app's edge — see `ImportDeps.hash`. */
export type HashBytes = (bytes: Uint8Array) => Promise<string>;

export interface DeriveLadderDeps {
  readonly aliases: MediaAliasStore;
  readonly database: DatabaseAdapter;
  /** Where the derived bytes land. The node's own local storage, never the cloud's. */
  readonly objectStorage: ObjectStorageAdapter;
  readonly clock: HLCClock;
  readonly hash: HashBytes;
  readonly encode: ImageEncoder;
  /** Which app owns the records this writes. Defaults to Photos, which is this app. */
  readonly originAppId?: string;
  /**
   * Charge these bytes to a budget.
   *
   * Optional, and its absence means the bytes are on disk and no budget knows
   * about them — which is exactly the `unknownKeys` state `reclaimSpace` reports
   * and expects to be zero. Supplied on a real node; omitted in a test that has
   * no residency policy to charge against.
   */
  readonly noteDerived?: (record: DataRecord) => Promise<void>;
}

export interface DeriveLadderOutcome {
  /** Records this pass decoded — the ones it actually paid for. */
  readonly scanned: number;
  /** Rungs written. */
  readonly written: number;
  /** Records whose decode or encode failed, which the next walk offers again. */
  readonly failed: number;
  /**
   * Every original this device holds has now been looked at.
   *
   * The signal to stop calling. A pass returning fewer aliases than it asked for
   * has reached the end of the table.
   */
  readonly complete: boolean;
  /** The alias key to resume after, or null once the walk is done. */
  readonly resumeAfter: string | null;
}

const RENDITION_LABEL = { appId: PHOTOS_APP_ID, key: PHOTOS_RENDITION_KEY };

/**
 * Walk this device's own originals from the cursor, deriving what is missing.
 *
 * The entry point a window calls, and the only one that moves the cursor.
 * Bounded three ways, and each bound answers a different failure:
 *
 *  - **the record budget**, so one window's derivation is a knowable amount of
 *    CPU rather than however many photographs happen to need rungs;
 *  - **the signal**, so a window that closes stops at a record boundary instead
 *    of being killed inside an encode, losing the report of everything it did;
 *  - **the page budget**, so a library that is already derived costs a slice of
 *    a walk per app open rather than a whole one.
 *
 * The page size itself is a fourth number and bounds nothing about the window:
 * it is what keeps the reads batched, so a record with nothing to do costs a
 * share of two queries rather than two of its own.
 *
 * `complete` means the walk reached the end of the alias table, and the cursor
 * is reset so the next window starts over — which is what finds the rungs a
 * newly imported photograph needs. Anything else leaves the cursor where the
 * sweep stopped.
 */
export async function deriveRenditions(
  deps: DeriveLadderDeps & { readonly cursor: ScanCursorStore },
  options: {
    readonly pageLimit?: number;
    readonly maxRecords?: number;
    readonly maxPages?: number;
    readonly signal?: { readonly aborted: boolean };
  } = {},
): Promise<DeriveLadderOutcome> {
  const pageLimit = options.pageLimit ?? DERIVE_PAGE_LIMIT;
  const budget = options.maxRecords ?? DERIVE_RECORD_BUDGET;
  const maxPages = options.maxPages ?? DERIVE_PAGE_BUDGET;

  let after = deps.cursor.get();
  let scanned = 0;
  let written = 0;
  let failed = 0;

  for (let pages = 0; pages < maxPages; pages += 1) {
    if (options.signal?.aborted) break;
    const page = await derivePage(deps, {
      limit: pageLimit,
      after,
      maxRecords: budget - scanned,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    scanned += page.scanned;
    written += page.written;
    failed += page.failed;

    if (page.complete) {
      deps.cursor.set(null);
      return { scanned, written, failed, complete: true, resumeAfter: null };
    }
    // Only ever forward. A page that stopped before its first record reports no
    // position, and writing that null would send the next window back to the
    // beginning of the table.
    if (page.resumeAfter !== null) {
      after = page.resumeAfter;
      deps.cursor.set(after);
    }
    if (scanned >= budget) break;
  }

  return { scanned, written, failed, complete: false, resumeAfter: after };
}

/**
 * Derive the rungs one page of aliases is missing.
 *
 * Exported for the sweep above and for the tests, which assert paging and the
 * budget against an explicit position rather than through a cursor.
 *
 * Never throws for one record's sake. A photograph this device cannot decode is
 * one record's failure and the rest of the page still derives — the same rule
 * every backfill beside it follows.
 */
export async function derivePage(
  deps: DeriveLadderDeps,
  options: {
    readonly limit: number;
    readonly after?: string | null;
    /** How many records this page may still decode. */
    readonly maxRecords?: number;
    readonly signal?: { readonly aborted: boolean };
  },
): Promise<DeriveLadderOutcome> {
  const page = deps.aliases.listAfter(options.after ?? null, options.limit);
  if (page.length === 0) {
    return { scanned: 0, written: 0, failed: 0, complete: true, resumeAfter: null };
  }

  // The records themselves, because an alias carries no type and this pass is
  // only for stills. A record the alias names but the database has lost is the
  // interrupted-import window `import.ts` is built around, and it is skipped —
  // the next import re-mints it.
  const ids = page.map((alias) => alias.recordId as StarkeepId);
  const found = await deps.database.query({
    filters: [{ field: "id", operator: "in", value: ids }],
    limit: ids.length,
  });
  const stills = new Map<StarkeepId, DataRecord>();
  for (const record of found.records) {
    if (typeCategory(record.type) === "image") stills.set(record.id, record);
  }

  // Two reads for the whole page before any file is opened, so a record with
  // nothing missing costs no decode: the dimensions that decide which rungs
  // apply, and the children that say which of them already exist.
  const dimensions = await deps.database.getMetadataByIds("image", [...stills.keys()]);
  const existing = await loadVariantCandidatesForPage(
    deps.database,
    [...stills.values()],
    RENDITION_LABEL,
  );

  const budget = options.maxRecords ?? Number.POSITIVE_INFINITY;
  let scanned = 0;
  let written = 0;
  let failed = 0;
  /**
   * The last alias this pass is finished with.
   *
   * Advanced only after a record is dealt with — derived, failed, or nothing to
   * do — never on the way in. That is what makes the position safe to stop at:
   * a resume from here re-reads no record twice and skips none, and a pass that
   * stops before its first record reports null rather than claiming to have
   * passed one.
   */
  let dealtWith: string | null = null;

  for (const alias of page) {
    // Both exits report the same position, and neither is an error: the window
    // closed, or this pass has decoded as much as it agreed to.
    if (options.signal?.aborted || scanned >= budget) {
      return { scanned, written, failed, complete: false, resumeAfter: dealtWith };
    }

    const record = stills.get(alias.recordId as StarkeepId);
    const row = record ? dimensions.get(record.id) : undefined;
    const width = typeof row?.["width"] === "number" ? row["width"] : 0;
    const height = typeof row?.["height"] === "number" ? row["height"] : 0;
    const sourceLongEdge = Math.max(width, height);
    // Three ways a record needs nothing from this pass, and all three cost no
    // decode. It is not a still, or the database has lost it — the
    // interrupted-import window `import.ts` is built around, which the next
    // import re-mints. It has no stored dimensions, so there is no applicable
    // set to compute: skipped rather than guessed, and a shrinking population,
    // since the EXIF backfill writes them and every import since has written
    // them inline. Or it already has every rung this device makes.
    const missing =
      record && sourceLongEdge > 0
        ? missingClasses(sourceLongEdge, existing.get(record.id) ?? [])
        : [];

    if (record && missing.length > 0) {
      scanned += 1;
      try {
        const rungs = await deriveOne(deps, record, alias.contentUri, sourceLongEdge, missing);
        // Null is a photograph this device could not read at all, and it is
        // counted with the throws rather than with the successes: both are a
        // record that paid its turn and produced nothing, and a pass reporting
        // four decoded and zero written with no failures would describe a bug.
        if (rungs === null) failed += 1;
        else written += rungs;
      } catch {
        // One photograph's failure. It is offered again on the next full walk,
        // because nothing records that it was tried — the same known cost the
        // EXIF and ThumbHash backfills carry, and the same fix would answer all
        // three.
        failed += 1;
      }
    }
    dealtWith = alias.objectStorageKey;
  }

  const complete = page.length < options.limit;
  return {
    scanned,
    written,
    failed,
    complete,
    resumeAfter: complete ? null : dealtWith,
  };
}

/**
 * Which rungs this device should make for this original and has not.
 *
 * Three filters, in this order: the ladder's own applicability rule, this
 * device's ceiling, and what already exists.
 *
 * A rung counts as existing only when it has dimensions. One without them is
 * invisible to variant resolution — it cannot be ordered, so it is dropped — and
 * re-deriving it is what repairs it: the bytes are the same, so the record is
 * content-addressed to the same id and the write puts the dimensions back.
 */
function missingClasses(
  sourceLongEdge: number,
  candidates: readonly { labelValue: string; width: number | null; height: number | null }[],
): StillClassSpec[] {
  const have = new Set(
    candidates
      .filter((c) => (c.width ?? 0) > 0 && (c.height ?? 0) > 0)
      .map((c) => c.labelValue),
  );
  return applicableStillClasses(sourceLongEdge)
    .filter((spec) => spec.maxLongEdge <= MOBILE_DERIVE_CEILING_LONG_EDGE)
    .filter((spec) => !have.has(spec.sizeClass));
}

/**
 * One record: decode once, encode each missing rung, publish each as a child.
 * Null when this device could not read the file at all.
 *
 * The decode is released whatever happens. It holds a bitmap of up to
 * {@link MOBILE_DERIVE_CEILING_LONG_EDGE} on a side in native memory, and a
 * reference dropped for the garbage collector to notice is a phone deriving four
 * records with four bitmaps still resident.
 */
async function deriveOne(
  deps: DeriveLadderDeps,
  parent: DataRecord,
  uri: string,
  sourceLongEdge: number,
  missing: readonly StillClassSpec[],
): Promise<number | null> {
  const decoded = await deps.encode(uri, MOBILE_DERIVE_CEILING_LONG_EDGE);
  if (decoded === null) return null;

  let written = 0;
  try {
    for (const spec of missing) {
      const encoded = await decoded.encode(
        renditionLongEdge(spec, sourceLongEdge),
        spec.quality,
      );
      await publishRendition(deps, parent, spec, encoded);
      written += 1;
    }
  } finally {
    decoded.release();
  }
  return written;
}

/**
 * Write one derived rung: the bytes, then its dimensions, then its label, then
 * the record.
 *
 * ## The order is the whole of this function
 *
 * **Bytes first.** A record whose blob is absent reads as `staged` — wanted, not
 * here — and a sync round would offer to fetch from the cloud bytes that are
 * sitting in local storage one write away.
 *
 * **Dimensions before the record.** Metadata rides the record over the wire,
 * read once per shipment after a round is cut, so a row written *after* `put` is
 * invisible to any round that cuts in between. That window is exactly the one
 * `publish-renditions.ts` documents at length: a rendition shipped without
 * dimensions is an unorderable candidate the far side drops, and a record whose
 * rungs are all dropped is indistinguishable from one with no rungs at all.
 *
 * **The label before the record too, and stamped after it.** Two different
 * things: the *write* goes first so no reader ever sees this child without the
 * label that makes it a rendition, and the *timestamp* comes from a later
 * `clock.now()` than the record's, so a round cut cannot ship the label ahead of
 * the record it describes. `round-cut.ts` records what that cost the last time
 * it happened — a handset holding rendition records whose label had been cut
 * away, unclassifiable to residency and invisible to the grid.
 *
 * The interrupted states are all self-repairing, and that is why this order is
 * safe without a transaction. A metadata row or a label whose record was never
 * written names an id nothing resolves; the next pass finds the rung still
 * missing, re-derives it from the same pixels, and the same content hash mints
 * the same id onto the same rows.
 */
async function publishRendition(
  deps: DeriveLadderDeps,
  parent: DataRecord,
  spec: StillClassSpec,
  encoded: EncodedRendition,
): Promise<void> {
  const contentHash = await deps.hash(encoded.bytes);
  const objectStorageKey = dataRecordObjectKey(RENDITION_TYPE, contentHash);

  await deps.objectStorage.put(objectStorageKey, encoded.bytes, {
    contentType: RENDITION_TYPE,
  });

  const record = createDataRecord(
    {
      type: RENDITION_TYPE,
      originAppId: deps.originAppId ?? PHOTOS_APP_ID,
      contentHash,
      objectStorageKey,
      sizeBytes: encoded.bytes.byteLength,
      mimeType: RENDITION_TYPE,
      parentId: parent.id,
      // The same name every other node gives this rung. It is part of the
      // content-addressed id, so spelling it differently here would be a second
      // naming rule producing a second id for the same rung of the same photo.
      originalFilename: renditionFileName(parent.originalFilename, spec.sizeClass),
    },
    deps.clock,
  );

  await deps.database.putMetadata("image", {
    recordId: record.id,
    width: encoded.width,
    height: encoded.height,
  });
  await deps.database.upsertLabels([
    {
      recordId: record.id,
      appId: PHOTOS_APP_ID,
      key: PHOTOS_RENDITION_KEY,
      value: spec.sizeClass,
      recordType: record.type,
      // Strictly above the record's own timestamp — see this function's header.
      hlc: deps.clock.now(),
    },
  ]);
  await deps.database.put(record);

  // Last, and after the record exists: the class these bytes are charged to is
  // read from the label rows above, so charging any earlier would resolve every
  // rendition this device makes as an original.
  await deps.noteDerived?.(record);
}
