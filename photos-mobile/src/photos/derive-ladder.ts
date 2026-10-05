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
 * **Nothing above `image-medium` in the cheap sweep.** See
 * {@link MOBILE_DERIVE_CEILING_LONG_EDGE}. The ceiling is an argument rather
 * than a constant this file reads, because it bounds a *budget*, and the cheap
 * sweep, the full-ladder sweep and an open have different ones. The full-ladder
 * sweep makes 2560 and the canonical at {@link FULL_DERIVE_CEILING_LONG_EDGE},
 * one record at a time and only when power allows; {@link deriveForRecord}
 * argues the open's case.
 *
 * **Nothing about archiving.** The platform decides when an original goes to
 * deep archive, from the canonical stand-in's arrival in the cloud. A sweep
 * never makes the canonical stand-in, so a photograph this device derives stays
 * out of deep archive until a node running `sharp` makes it — or until a viewer
 * that raised the ceiling far enough made it here. Both encoders are libavif
 * over aom at the same quality and the same 4:2:0 chroma, so a stand-in is a
 * stand-in whoever made it.
 *
 * **Nothing derived from a rendition.** The source is always an original whose
 * bytes are on this device, reached through the media alias — which is also what
 * keeps this pass to one rule about where bytes come from rather than two. The
 * case a rendition source would serve barely exists: the ladder is a contiguous
 * prefix, so a device holding a rung *above* the one it wants has almost always
 * had the one it wants derived alongside it.
 *
 * **Nothing to a video.** A poster is a frame extraction and a skim is a
 * transcode; neither is an AVIF encode of a decoded still, so neither belongs in
 * this pass.
 *
 * ## Two entry points, and why one was not enough
 *
 * {@link deriveRenditions} sweeps, from a cursor, in `object_storage_key` order.
 * That is the right shape for a backlog and the wrong one for what somebody is
 * looking at: the key is a content hash, so the records a sweep reaches bear no
 * relation to the records on screen, and the budgets that keep a sweep
 * affordable — four records a background window, twelve an app open — mean a
 * camera roll that predates this build converges in years.
 *
 * {@link deriveForRecord} is the other shape: one named record, now, because a
 * surface could not paint it. The grid knows exactly which records it could not
 * paint, which makes it the best-ordered work queue in the app. The sweep still
 * grinds the tail, and neither can mint a rung the other already made — both
 * decide missing the same way, through {@link missingClasses}.
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
  checkStandInWrite,
  createDataRecord,
  dataRecordObjectKey,
  DEFAULT_STAND_IN_STANDARDS,
  stampFor,
  typeCategory,
  type DataRecord,
  type HLCClock,
  type StandInStandards,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import type { LibrarySettings } from "@starkeep/sync-engine";
import type { DatabaseAdapter, ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { isStandInSlotConflict, loadStandInsForPage } from "@starkeep/storage-adapter";
import {
  applicableStillClasses,
  classForStandIn,
  renditionFileName,
  renditionLongEdge,
  standInFieldsFor,
  STILL_LADDER,
  type StandInTarget,
  type StillClassSpec,
} from "@starkeep/photos-ladder";
import type { MediaAliasStore } from "../media/media-alias";
import { standInTargetFor } from "./stand-in-target";
import type { ScanCursorStore } from "../work/scan-cursor";
import { PHOTOS_APP_ID } from "./renditions";

/**
 * The largest rung a background sweep will produce.
 *
 * `image-medium` — the rung on-device models read, the viewer's first stage, and
 * the share and export default. Above it are 2560 and 4272, which are a real CPU
 * cost for pixels a phone screen cannot show, and they remain the work of a node
 * running `sharp` *for a sweep*.
 *
 * ## Why this is a default and not a limit
 *
 * The number bounds a decode, and a decode's cost has to be weighed against what
 * it is for. Decoding an original at 2560 holds roughly 20 MB of bitmap in
 * native memory while the encode runs. That is unaffordable four records at a
 * time in a background window over a whole camera roll, and affordable once for
 * the photograph somebody is looking at. So the two callers pass different
 * values, and {@link deriveForRecord} takes it as an argument.
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

/**
 * The largest rung the full-ladder sweep makes: the top of the ladder, which is
 * the canonical stand-in. A phone that derives its own photographs in full is
 * what spares a desktop from fetching their originals to do it.
 */
export const FULL_DERIVE_CEILING_LONG_EDGE: number = Math.max(
  ...STILL_LADDER.map((spec) => spec.maxLongEdge),
);

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
  /**
   * The library's standards, and whether this node may stamp originals with
   * them. Absent in a test with no settings, which reads as the platform
   * defaults and a node that knows them.
   */
  readonly librarySettings?: Pick<LibrarySettings, "standards" | "knowsLibraryValue">;
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
    /**
     * The largest rung this sweep makes. The background default stops at
     * `image-medium`; the full-ladder sweep passes the canonical size, and runs
     * only when power allows.
     */
    readonly ceilingLongEdge?: number;
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
      ...(options.ceilingLongEdge !== undefined ? { ceilingLongEdge: options.ceilingLongEdge } : {}),
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
    /** The largest rung to make. See {@link deriveRenditions}. */
    readonly ceilingLongEdge?: number;
  },
): Promise<DeriveLadderOutcome> {
  const ceiling = options.ceilingLongEdge ?? MOBILE_DERIVE_CEILING_LONG_EDGE;
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
  const existing = await loadStandInsForPage(deps.database, [...stills.values()]);

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
    // The original's fidelity, before anything is decided about its rungs. An
    // original too small to take any stand-in is the case that needs it most:
    // without it no node can tell the original is self-canonical, and every
    // other node treats it as above its ceiling.
    const current = record && sourceLongEdge > 0 ? await recordFidelity(deps, record, sourceLongEdge) : record;
    // Three ways a record needs nothing from this pass, and all three cost no
    // decode. It is not a still, or the database has lost it — the
    // interrupted-import window `import.ts` is built around, which the next
    // import re-mints. It has no stored dimensions, so there is no applicable
    // set to compute: skipped rather than guessed, and a shrinking population,
    // since the EXIF backfill writes them and every import since has written
    // them inline. Or it already has every rung this device makes.
    const missing =
      current && sourceLongEdge > 0
        ? missingClasses(
            sourceLongEdge,
            current.sizeBytes,
            existing.get(current.id) ?? [],
            // The caller's ceiling: the standing one for the cheap sweep, the
            // canonical size for the full-ladder sweep that waits for power.
            // See `deriveForRecord` for the viewer, which raises it per photo.
            ceiling,
            targetOf(deps, current, existing.get(current.id) ?? []),
          )
        : [];

    if (current && missing.length > 0) {
      scanned += 1;
      try {
        const rungs = await deriveOne(
          deps,
          current,
          alias.contentUri,
          sourceLongEdge,
          missing,
          ceiling,
          targetOf(deps, current, existing.get(current.id) ?? []),
        );
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
 * Derive one named record's missing rungs, now, because a surface is showing it.
 *
 * ## Why the cursor walk is not enough on its own
 *
 * {@link deriveRenditions} walks the alias table in `object_storage_key` order,
 * which is a content hash — so the records it reaches bear no relation to the
 * ones on screen. Paired with the budgets that keep a sweep affordable (four
 * records a background window, twelve an app open), a camera roll that predates
 * this build converges in years, and the twelve it does derive are twelve
 * arbitrary photographs. The sweep is the right shape for a backlog and the
 * wrong shape for the thing somebody is looking at.
 *
 * This is the other half: the grid knows exactly which records it could not
 * paint, and that is the best-ordered work queue in the app. The sweep still
 * grinds the tail.
 *
 * ## What it will not do, and why each refusal matters
 *
 * **Nothing for a record without an alias.** The bytes have to be on this device
 * already, which for this app means the camera roll. A record that arrived by
 * sync is the other node's to derive — the rule the sweep follows, restated here
 * because this entry point is reachable per tile and would otherwise become a
 * way for a phone to volunteer for every original it ever fetched.
 *
 * **Nothing for a rung that already has a record.** {@link missingClasses} is
 * the only definition of missing, and it counts records rather than bytes. That
 * is load-bearing here rather than incidental: a rung derived on another node
 * and synced down as a row has bytes this device can *fetch*, and re-encoding it
 * locally would produce different bytes, a different content hash and therefore
 * a **second record for the same rung of the same photograph**. An evicted rung
 * is the same case. Both want `fetchBlob`, not this.
 *
 * It is also what makes this pass unable to cycle with the fetch it defers to.
 * Counting records means an evicted rung and a duplicated rung both read as
 * present, so no amount of eviction pressure can make this device derive a class
 * it has already derived once — there is no derive/fetch/evict/derive loop to
 * fall into.
 *
 * ## The ceiling is the caller's, and this is the caller that raises it
 *
 * `ceilingLongEdge` defaults to {@link MOBILE_DERIVE_CEILING_LONG_EDGE}, which is
 * the sweep's budget. The viewer passes the rung it actually needs instead.
 *
 * The distinction the argument draws is between a background pass over a whole
 * camera roll and one record somebody has deliberately opened. The first cannot
 * afford a 20 MB bitmap four times a window; the second pays it once, for a
 * photograph that is on screen, and the alternative is a fetch over the network
 * for pixels that are already in the camera roll.
 *
 * **Nothing for a video, and nothing without stored dimensions.** The first
 * because a poster is a frame extraction rather than an encode of a decoded
 * still; the second because there is no applicable set to compute, which is
 * skipped rather than guessed.
 *
 * ## What the return value distinguishes
 *
 * `null` — nothing here can be derived, ever, for this record: not a still, not
 * aliased, no dimensions, or the file would not decode. A caller may stop
 * asking.
 *
 * `0` — nothing is missing. Every rung this device makes already has a record,
 * so what the surface wants is a fetch.
 *
 * `n` — rungs written, and the caller should re-resolve the record.
 *
 * Throws only what {@link deriveOne} throws, which is one encode's failure. The
 * caller decides whether one photograph failing is worth reporting; the sweep
 * counts it and carries on.
 */
export async function deriveForRecord(
  deps: DeriveLadderDeps,
  record: DataRecord,
  ceilingLongEdge: number = MOBILE_DERIVE_CEILING_LONG_EDGE,
): Promise<number | null> {
  if (typeCategory(record.type) !== "image") return null;

  // The alias is both the permission and the address: it says these bytes are
  // this device's to decode, and it carries the `content://` URI to open. One
  // indexed lookup, which is what makes this affordable per tile.
  const alias = deps.aliases.ofRecord(record.id)[0];
  if (!alias) return null;

  const row = (await deps.database.getMetadataByIds("image", [record.id])).get(record.id);
  const width = typeof row?.["width"] === "number" ? row["width"] : 0;
  const height = typeof row?.["height"] === "number" ? row["height"] : 0;
  const sourceLongEdge = Math.max(width, height);
  if (sourceLongEdge <= 0) return null;

  const current = await recordFidelity(deps, record, sourceLongEdge);
  const existing = await loadStandInsForPage(deps.database, [current]);
  const target = targetOf(deps, current, existing.get(current.id) ?? []);
  const missing = missingClasses(
    sourceLongEdge,
    current.sizeBytes,
    existing.get(current.id) ?? [],
    ceilingLongEdge,
    target,
  );
  if (missing.length === 0) return 0;

  return deriveOne(deps, current, alias.contentUri, sourceLongEdge, missing, ceilingLongEdge, target);
}

/**
 * Record an original's fidelity when nothing has, and answer the record as it
 * now stands.
 *
 * A platform write onto the original's row under a fresh clock, so the value
 * reaches every other node, and so a peer applying this row and a stand-in in
 * clock order meets the fidelity first. That order is what lets the cloud
 * decide archiving the moment the canonical stand-in lands. Called once per
 * record, before any stand-in is written — never per rung, which would move the
 * original's clock once for every size.
 *
 * The long edge comes from the stored dimensions, which is the displayed long
 * edge whatever the EXIF orientation says: a quarter turn swaps width and
 * height but not the larger of the two.
 */
async function recordFidelity(
  deps: DeriveLadderDeps,
  record: DataRecord,
  sourceLongEdge: number,
): Promise<DataRecord> {
  if (record.fidelity !== null) return record;
  const updated: DataRecord = {
    ...record,
    fidelity: sourceLongEdge,
    // Stamped with the threshold the original is judged by, when this node
    // knows the library's value; the cloud stamps it otherwise.
    canonicalThreshold:
      record.canonicalThreshold ??
      stampFor(record.type, standardsOf(deps), deps.librarySettings?.knowsLibraryValue() ?? true),
    updatedAt: deps.clock.now(),
    version: record.version + 1,
  };
  await deps.database.put(updated);
  return updated;
}

/** The library's standards as this node knows them. */
function standardsOf(deps: DeriveLadderDeps): StandInStandards {
  return deps.librarySettings?.standards() ?? DEFAULT_STAND_IN_STANDARDS;
}

/** What this original asks of the ladder; see `stand-in-target.ts`. */
function targetOf(
  deps: DeriveLadderDeps,
  original: DataRecord,
  standIns: readonly DataRecord[],
): StandInTarget | null {
  return standInTargetFor(original, standIns, standardsOf(deps));
}

/**
 * Which rungs this device should make for this original and has not.
 *
 * Three filters, in this order: the ladder's own applicability rule — which
 * with the original's size decides whether it takes a canonical stand-in at
 * all — this device's ceiling, and what already exists. A stand-in exists when
 * any node or app made it: the platform keeps one per size per original, so a
 * second encode here would only be refused.
 */
function missingClasses(
  sourceLongEdge: number,
  sourceSizeBytes: number,
  standIns: readonly DataRecord[],
  ceilingLongEdge: number,
  target: StandInTarget | null,
): StillClassSpec[] {
  const have = new Set(
    standIns
      .filter((s) => !s.deletedAt && s.standInRole !== null && s.fidelity !== null)
      .map((s) => classForStandIn("image", s.standInRole!, s.fidelity!)),
  );
  return applicableStillClasses(sourceLongEdge, sourceSizeBytes, target)
    .filter((spec) => renditionLongEdge(spec, sourceLongEdge, target) <= ceilingLongEdge)
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
  ceilingLongEdge: number,
  target: StandInTarget | null,
): Promise<number | null> {
  const decoded = await deps.encode(uri, ceilingLongEdge);
  if (decoded === null) return null;

  let written = 0;
  try {
    for (const spec of missing) {
      const encoded = await decoded.encode(
        renditionLongEdge(spec, sourceLongEdge, target),
        spec.quality,
      );
      if (await publishStandIn(deps, parent, spec, sourceLongEdge, encoded, target)) written += 1;
    }
  } finally {
    decoded.release();
  }
  return written;
}

/**
 * Write one rung as a stand-in: the bytes, then the record. Returns false when
 * another node's stand-in already holds the slot.
 *
 * ## The order is the whole of this function
 *
 * **Bytes first.** A record whose blob is absent reads as `staged` — wanted, not
 * here — and a sync round would offer to fetch from the cloud bytes that are
 * sitting in local storage one write away.
 *
 * The original's fidelity is already on its row — {@link recordFidelity} runs
 * before any decode — so the rules below read a parent that says how big it is.
 *
 * **Then the record,** carrying its role and fidelity as columns. There is no
 * label to write and no metadata row: the columns are what every reader, and
 * the platform's own rules, read a stand-in by.
 *
 * The rules the servers check at write are checked here too — this device is
 * its own data plane — and a refused rung is skipped rather than written.
 */
async function publishStandIn(
  deps: DeriveLadderDeps,
  parent: DataRecord,
  spec: StillClassSpec,
  sourceLongEdge: number,
  encoded: EncodedRendition,
  target: StandInTarget | null,
): Promise<boolean> {
  const fields = standInFieldsFor(spec.sizeClass, sourceLongEdge, target?.canonical);
  if (!fields) return false;

  const verdict = checkStandInWrite(
    {
      type: RENDITION_TYPE,
      role: fields.role,
      fidelity: fields.fidelity,
      parent,
      parentIdGiven: true,
      existingCanonical: null,
    },
    standardsOf(deps),
  );
  if (verdict.refusals.length > 0) {
    console.warn(
      `[derive] ${spec.sizeClass} of ${parent.id} refused: ${verdict.refusals.map((r) => r.code).join(", ")}`,
    );
    return false;
  }

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
      standInRole: fields.role,
      fidelity: fields.fidelity,
    },
    deps.clock,
  );
  try {
    await deps.database.put(record);
  } catch (err) {
    // Another node's stand-in holds the slot; the platform keeps that one.
    if (isStandInSlotConflict(err)) return false;
    throw err;
  }

  // After the record exists, so the class these bytes are charged to is read
  // from the record's own role.
  await deps.noteDerived?.(record);
  return true;
}
