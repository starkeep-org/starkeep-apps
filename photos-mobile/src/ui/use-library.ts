/**
 * Bringing the node up, and keeping the screen's view of it fresh.
 *
 * Two hooks, split because they fail differently. The node comes up once and
 * either works or does not; the library is queried repeatedly and every query
 * can be stale. Folding them together would make a failed import look like a
 * failed node.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, PixelRatio } from "react-native";
import {
  ceilingChoices,
  createHLCClock,
  DEFAULT_SYNC_DOWN_CEILINGS,
  STAND_IN_CATEGORIES,
  typeCategory,
  type DataRecord,
  type HLCClock,
  type MetadataRow,
  type StandInCategory,
  type StarkeepId,
  type SyncDownCeilings,
} from "@starkeep/protocol-primitives";
import {
  listLibrary,
  refreshLibraryItem,
  resolveForViewer,
  type LibraryItem,
} from "../library";
import {
  IMAGE_EXIF_BACKFILL_LIMIT,
  NULL_MODIFIED_SWEEP_LIMIT,
  type ImportOutcome,
} from "../media/import";
import { THUMB_HASH_BACKFILL_LIMIT } from "../media/thumb-hash";
import type { NodeIdentity } from "../node-identity";
import type { CloudConnection } from "../auth/connection";
import type { MobileNode, StorageReport } from "../node";
import type { CaptionStore } from "../photos/captions";
import {
  backfillImageExifFor,
  backfillVideoPostersFor,
  backfillThumbHashesFor,
  deriveRecordFor,
  deriveRenditionsFor,
  backfillVideoDurationsFor,
  deleteRecordFor,
  deviceMedia,
  importRecentFor,
  openMotionPhotoFor,
  sweepNullModifiedFor,
  trashCameraRollFiles,
} from "../platform";
import type { OpenMotionPhoto } from "../media/motion-photo-playback";
import { acquireNode, closeNodeForReset, type NodeLease } from "../work/node-handle";
import { ceilingsOf, type DeviceSettings } from "../device-settings";
import { GRID_GAP, libraryColumns, libraryGridWidth, libraryTileSize } from "./theme";
import { type Dimensions as Box, type GridGeometry } from "../photos/render-target";
import {
  createInFlight,
  RENDITION_DERIVE_CONCURRENCY,
  RENDITION_FETCH_CONCURRENCY,
} from "../work/in-flight";

/**
 * Which surface is asking for a rendition.
 *
 * The two differ in size and in when they fire, and both differences matter
 * enough to name rather than to pass a number for.
 *
 * A **tile** wants one square of the grid, and the page already resolved what
 * it is missing — so the fetch costs no resolution. It fires only when the tile
 * has no resident rung at all, because a grid that issued a request per tile per
 * scroll would be a request storm; the rungs the sync prefetches exist so the
 * grid draws from disk.
 *
 * The **viewer** wants a full screen, which is a bigger target than any tile's
 * and therefore usually a different rung. It resolves on open, unconditionally,
 * because there is exactly one of it and somebody is looking at it.
 */
export type RenditionSurface = "tile" | "viewer";

/**
 * How many records one library page asks for.
 *
 * **A page size now, where it used to be a ceiling.** Sixty was the whole grid:
 * `listLibrary` already returned `nextCursor` and `hasMore` and the hook threw
 * both away, so a node holding 510 records showed 60 of them and offered no way
 * to reach the rest. Which 60 depended on the sort order, and the sort order
 * was import time — so tapping "Add photos from this device" pushed the most
 * recent photographs off the bottom.
 *
 * ## Why the number is computed
 *
 * The same argument {@link tileLongEdge} makes: the grid's geometry is a closed
 * form over the window and `theme.ts` owns its constants, so a number written
 * beside them drifts from the layout silently. A page is what fits on screen
 * plus one screen of headroom, which is what lets the next page start loading a
 * full screen before anyone reaches the bottom — the same distance
 * `onEndReachedThreshold` is set to.
 *
 * Clamped at both ends. The floor keeps a small window from paging in
 * dribs; the ceiling keeps a large one from asking for more tiles than the
 * decoder can keep up with in a single burst. Rounded to whole rows, because a
 * partial trailing row is a ragged edge mid-list.
 */
export function libraryPageSize(): number {
  const window = Dimensions.get("window");
  const columns = libraryColumns(window);
  const rowHeight = libraryTileSize(libraryGridWidth(window.width), columns) + GRID_GAP;
  const rowsOnScreen = Math.ceil(window.height / Math.max(1, rowHeight));
  const tiles = Math.min(Math.max(rowsOnScreen * 2 * columns, 30), 90);
  return Math.ceil(tiles / columns) * columns;
}

/**
 * How many pages a reload re-fetches before it gives up and starts over.
 *
 * A reload happens for reasons that have nothing to do with where somebody has
 * scrolled to — a blob arrived, an import finished, the screen was pulled down
 * — and dropping them back to the top of a library they had scrolled deep into
 * would be worse than the stale tile the reload was fixing. So it restores what
 * was loaded.
 *
 * Ten is where restoring stops being worth it: past that the reload costs ten
 * queries and a thousand tiles to repair one, and starting over costs one query.
 */
export const MAX_RELOADED_PAGES = 10;

/**
 * The grid a library page will be laid out in.
 *
 * ## Geometry, never a pixel count and never a class name
 *
 * Every tile is the same square, but the pixel count is still per record: a
 * centre crop needs the photograph's long edge to cover the overflow, and that
 * depends on the photograph's shape.
 *
 * What travels is the geometry the layout will use, and
 * `photos/render-target.ts` turns it into a request per record. The unit at that
 * boundary is still pixels and never a class name — the contract every Photos
 * surface shares, and what lets the ladder be respecified without touching a
 * caller.
 *
 * ## Still computed rather than measured
 *
 * Every input is known before layout runs: the window, the padding `theme.ts`
 * owns, and the column count it derives from the window. An `onLayout` here would report a number
 * this already has, one frame later. The web app's viewer makes the same
 * argument about its own stage.
 *
 * Read at query time rather than cached, so a rotation is picked up by the next
 * reload without a listener.
 */
function gridGeometry(): GridGeometry {
  const window = Dimensions.get("window");
  return {
    tileSize: libraryTileSize(libraryGridWidth(window.width), libraryColumns(window)),
    devicePixelRatio: PixelRatio.get(),
  };
}

/**
 * How many assets a foreground catch-up considers.
 *
 * Sixty, rather than the background tick's twenty.
 * The tick's number is small because the OS can take the window back at any
 * moment and a unit that does not finish never finishes; a foreground pass has
 * no window to lose and a person is watching it, so it may as well drain a
 * burst of captures in one go.
 */
export const FOREGROUND_IMPORT_LIMIT = 60;

/**
 * How many clips one duration-backfill pass looks at.
 *
 * Much smaller than the import limit, because the two passes pay for different
 * things. Import pays per asset it actually reads and hashes, and skips the rest
 * cheaply; the backfill pays the media store's per-row probe for every row it
 * asks for and writes one small column. Twenty-five keeps a pass well inside the
 * frame budget of a screen somebody is looking at, and the pass runs on every
 * app open until it reports that it has reached the end of the roll.
 */
export const VIDEO_DURATION_BACKFILL_LIMIT = 25;

/**
 * How many EXIF batches one app open will run before giving up the thread.
 *
 * The ceiling on {@link LibraryState.backfillExif}'s loop, and a bound on a walk
 * whose end is the end of a camera roll — which is not a bounded thing. Sixty
 * batches is roughly five hundred photographs, well past what any handset needs
 * to converge, and the watermark means stopping short costs only the next app
 * open.
 */
export const MAX_EXIF_BACKFILL_PASSES = 60;

/** Aliases per poster-backfill page; only the videos among them cost a decode. */
export const VIDEO_POSTER_BACKFILL_LIMIT = 24;

/**
 * How many ThumbHash batches one app open will run before giving up the thread.
 *
 * **Ten, where the EXIF walk gets sixty, and the difference is the point.** The
 * EXIF walk runs to completion in one open because a half-repaired library is
 * *ordered* worse than an unrepaired one — the records that happen to have a
 * capture time float above every record that does not, so the intermediate
 * state is something somebody looks at. Placeholders have no such property: a
 * library where some tiles have one and the rest paint what they already
 * painted is strictly better than one where none do, and it improves in the same
 * direction on every open.
 *
 * So this pass takes the opposite trade. Each batch decodes twelve photographs,
 * which is real work on a thread that is drawing a grid, and there is no reason
 * to spend a minute of it at once for a result nobody is waiting on.
 */
export const MAX_THUMB_HASH_BACKFILL_PASSES = 10;

/**
 * How many records one app open derives renditions for.
 *
 * **Twelve, and the number exists because the background window cannot carry
 * this on its own.** A window is ninety seconds, import and sync take their
 * shares first, and derivation's own share of what is left comes to a handful of
 * records — against roughly six windows in a day's allowance. A camera roll that
 * predates this build would converge in years.
 *
 * So the foreground pays for the backlog and the background keeps up with new
 * captures, which is the same division of labour "Add photos from this device"
 * already makes with the import watermark.
 *
 * Twelve rather than the ThumbHash pass's hundred-and-twenty (ten batches of
 * twelve) because one record here is a decode *and* up to three AVIF encodes.
 * Both of those run on native queues rather than on the JavaScript thread, so
 * the grid keeps drawing — what this number actually bounds is battery and heat
 * on an app open, not frames.
 */
export const DERIVE_RECORDS_PER_OPEN = 12;

export type NodeState =
  | { readonly status: "starting" }
  | {
      readonly status: "ready";
      readonly node: MobileNode;
      readonly identity: NodeIdentity;
      readonly clock: HLCClock;
      /** What connects this phone to a cloud, or null when it is signed out. */
      readonly connection: CloudConnection | null;
    }
  | { readonly status: "failed"; readonly error: string };

/**
 * Open this device's node, once.
 *
 * Failure is a state rather than a throw. The database or the object store can
 * genuinely fail to open — a full disk, a corrupt file — and a screen that
 * says so is worth more than a red box, because the thing that failed is the
 * thing the user would otherwise be told is empty.
 */
export interface NodeHandle {
  readonly state: NodeState;
  /**
   * Close the node and open it again, keeping everything it holds.
   *
   * For signing in and out: the session decides whether the node has a cloud,
   * and the node reads it only when it opens.
   */
  reopen: () => Promise<void>;
}

export function useNode(): NodeHandle {
  const [state, setState] = useState<NodeState>({ status: "starting" });
  /** Bumped to force the effect to build a new node after a reopen. */
  const [generation, setGeneration] = useState(0);
  const current = useRef<MobileNode | null>(null);
  /** Resolved by the effect once the reopened node is up. */
  const opening = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let lease: NodeLease | null = null;

    void acquireNode()
      .then((acquired) => {
        lease = acquired;
        if (cancelled) {
          // Acquired after the screen went away — hand the claim straight back
          // rather than hold one for the rest of the process's life.
          void acquired.release();
          return;
        }
        current.current = acquired.node;
        setState({
          status: "ready",
          node: acquired.node,
          identity: acquired.identity,
          clock: createHLCClock({ nodeId: acquired.identity.nodeId }),
          connection: acquired.connection,
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "failed", error: String(err) });
      })
      .finally(() => {
        opening.current?.();
        opening.current = null;
      });

    return () => {
      cancelled = true;
      current.current = null;
      // Release rather than close. The background tick may hold a claim on the
      // same node, and the screen going away is not a reason to shut the
      // database under it — the handle closes when the last holder lets go.
      // A claim from before a reset releases to nothing, which the handle's
      // own generation check enforces.
      void lease?.release();
    };
  }, [generation]);

  const reopen = useCallback(async () => {
    current.current = null;
    setState({ status: "starting" });
    // Close the shared node so the next open builds a fresh one, then let the
    // effect build it. Every outstanding claim is invalidated by the close.
    await closeNodeForReset();
    const built = new Promise<void>((resolve) => {
      opening.current = resolve;
    });
    setGeneration((n) => n + 1);
    await built;
  }, []);

  return { state, reopen };
}

export interface LibraryState {
  readonly items: readonly LibraryItem[];
  readonly loading: boolean;
  /**
   * Whether a read of the library has finished at least once.
   *
   * Apart from {@link loading} because `loading` is false before the node is
   * ready, too, when nothing has been read yet. An empty grid means "no
   * photos" only once this holds; before it, the grid does not know.
   */
  readonly loaded: boolean;
  /**
   * A further page is being appended.
   *
   * Carried apart from {@link loading} because the two need different words on
   * screen. `loading` is "there is nothing to show yet"; this is "there is a
   * grid and more is coming", and letting the first say the second would blank
   * a screenful of photographs to report progress on the one below it.
   */
  readonly loadingMore: boolean;
  /** Whether the library holds records past the ones loaded. */
  readonly hasMore: boolean;
  /**
   * Why the last attempt to append a page failed, or null.
   *
   * Reported rather than swallowed. The first version caught and discarded it on
   * the argument that a red line under a working library describes the wrong
   * thing — but the result is a grid that says more exists and then does
   * nothing, forever, with no way to tell a failure from an empty tail.
   */
  readonly loadMoreError: string | null;
  readonly error: string | null;
  reload: () => Promise<void>;
  /**
   * Append the next page, if there is one.
   *
   * Safe to call on every scroll event: a call with nothing left to load, or
   * with a load already in flight, resolves without doing anything.
   */
  loadMore: () => Promise<void>;
  /**
   * Import without asking for anything.
   *
   * The import the foreground catch-up runs. It reads the media permission
   * rather than requesting it — `useForegroundWork` asks once, up front — and it
   * passes the import watermark, so a pass on a quiet phone asks the media store
   * for nothing and costs nothing. See `ImportDeps.importCursor`.
   *
   * Resolves null when the pass did not happen — no node, or no permission —
   * which the caller reports rather than swallowing.
   */
  importQuietly: () => Promise<ImportOutcome | null>;
  /**
   * Repair one batch of clips imported before a record carried a duration.
   *
   * Resolves true when there is nothing left to repair, which is the caller's
   * signal to stop asking. See `backfillVideoDurations`.
   */
  backfillDurations: () => Promise<boolean>;
  /**
   * Repair one batch of stills imported before a record carried a capture time.
   *
   * Resolves true when there is nothing left to repair, which is the caller's
   * signal to stop asking. See `backfillImageExif`.
   */
  backfillExif: () => Promise<boolean>;
  /**
   * Give a placeholder to records imported before this device made them.
   *
   * Resolves true when there is nothing left to repair, which is the caller's
   * signal to stop asking. See `backfillThumbHashes`.
   */
  backfillThumbHashes: () => Promise<boolean>;
  /**
   * Give posters and a capture time to videos imported before this device
   * made them.
   *
   * Resolves true when there is nothing left to repair, which is the caller's
   * signal to stop asking. See `backfillVideoPosters`.
   */
  backfillPosters: () => Promise<boolean>;
  /**
   * Make the rungs this device's own photographs are missing.
   *
   * Resolves true when the sweep has walked every original this node holds,
   * which is the caller's signal to stop asking for this app open. Unlike the
   * repairs beside it that is not a permanent answer — a photograph imported
   * afterwards needs rungs too — so the sweep's cursor resets and the next open
   * walks again. See `photos/derive-ladder.ts`.
   */
  deriveRenditions: () => Promise<boolean>;
  /**
   * Import the assets the import watermark can never reach.
   *
   * Resolves the number imported, so a caller can decide whether the grid needs
   * reloading. Usually zero — the assets this finds are rare — which is exactly
   * why it must not reload unconditionally. See `importNullModified`.
   */
  sweepNullModified: () => Promise<number>;
  /**
   * The clip inside a Motion Photo, as a file a player can open.
   *
   * Resolves null for the ordinary photograph, which is most of them. The caller
   * owns the handle and must `release()` it — the scratch file lasts exactly one
   * viewing by design. See `media/motion-photo-playback.ts`.
   */
  openMotion: (item: LibraryItem) => Promise<OpenMotionPhoto | null>;
  /**
   * The record's metadata row — dimensions, capture time and whatever EXIF a
   * node has read — for the viewer's info sheet. Null for a record with no row
   * or of a type with no metadata table.
   */
  readInfo: (record: DataRecord) => Promise<MetadataRow | null>;
  /**
   * Photos' captions on this phone, for the viewer and its info sheet, or null
   * before the node is ready. See `photos/captions.ts`.
   */
  captions: CaptionStore | null;
  /**
   * Delete a library item in Starkeep, then offer Android's trash for its
   * camera-roll file. The grid reloads before the trash dialog opens, so the
   * item leaves the grid and the viewer whatever the person answers there.
   * Rejects when the Starkeep delete fails.
   */
  deleteRecord: (record: DataRecord) => Promise<void>;
  /**
   * Pull down a record whose bytes are not on this device.
   *
   * Exposed as an action rather than done automatically, because the whole point
   * of eliding is that this node decided not to hold these bytes — fetching them
   * back is a request, and it is the *only* route back: the watermark has moved
   * past the record, so no sync round will ever offer it again.
   *
   * Resolves false when the fetch did not happen, which the caller surfaces
   * rather than swallowing: on a phone with no session there is nowhere to fetch
   * from, and silently doing nothing would read as a broken button.
   */
  fetchBlob: (item: LibraryItem) => Promise<boolean>;
  /**
   * Fetch the rung a surface wants, when its bytes are not on this device.
   *
   * **The thing that used to be missing entirely.** The phone resolved which
   * rung it wanted, found the bytes absent, and painted the original instead —
   * so nothing ever fetched a rendition, and the only transfer the app could
   * start was a download of a whole original.
   *
   * Resolves true when bytes arrived. False covers every other outcome and none
   * of them is an error worth a line on screen: there was nothing to fetch, the
   * ideal rung has not been derived anywhere, or this device has no session.
   *
   * Deduplicated per record and target, and capped at three at once. See
   * `work/in-flight.ts`.
   */
  fetchRendition: (item: LibraryItem, surface: RenditionSurface) => Promise<boolean>;
  /**
   * Make this record's missing rungs now, because a surface cannot paint it.
   *
   * The producer beside {@link fetchRendition}'s consumer, and the distinction
   * between them is which node owns the original. A record whose rungs exist
   * somewhere wants bytes moved; a photograph out of this device's own camera
   * roll that nothing has derived wants work commissioned, and until this
   * existed nothing on any surface could ask for it — the sweep got to it
   * eventually, in content-hash order, twelve records to an app open.
   *
   * Resolves true when rungs were written and the tile is worth re-resolving.
   * False covers every other outcome and none is an error worth a line on
   * screen: the record is not this device's to derive, its rungs already exist,
   * or the build has no encoder.
   *
   * Deduplicated per record and capped, on its own pool rather than the fetch
   * pool — a decode and three encodes must not be able to starve a download.
   */
  deriveNow: (
    item: LibraryItem,
    surface: RenditionSurface,
    /**
     * The largest rung to make, defaulting to the sweep's ceiling.
     *
     * The viewer passes what its stage needs, which is how one photograph comes
     * to get an `image-screen` a background pass would never spend the memory
     * on. See `MOBILE_DERIVE_CEILING_LONG_EDGE`.
     */
    ceilingLongEdge?: number,
  ) => Promise<boolean>;
  /**
   * The item as the viewer should paint it, resolved at the viewer's own size.
   *
   * Called on open and again after a fetch lands. The second call is what stops
   * the viewer from reporting bytes as absent once they have arrived — it holds
   * the item it was opened with, and nothing else would tell it otherwise. See
   * `resolveForViewer`.
   */
  openForViewer: (item: LibraryItem, stage: Box) => Promise<LibraryItem>;
}

/** What the Storage section shows, and the action that changes it. */
export interface StorageState {
  readonly report: StorageReport | null;
  readonly error: string | null;
  refresh: () => void;
  /**
   * This device's sync-down ceilings in force, per category, with the sizes a
   * person can pick and the phone defaults; null until the node is up.
   */
  readonly ceilings: CeilingsView | null;
  setCeiling: (category: StandInCategory, ceiling: number | null) => void;
}

/** What the Storage section draws its ceiling pickers from. */
export interface CeilingsView {
  readonly current: SyncDownCeilings;
  readonly defaults: SyncDownCeilings;
  /**
   * The sizes to offer besides none: the library's standard sizes and
   * canonical threshold, which is the list admin-web offers on a desktop.
   */
  readonly choices: Readonly<Record<StandInCategory, readonly number[]>>;
  /** The library's canonical threshold per category, which a picker marks. */
  readonly canonical: Readonly<Record<StandInCategory, number>>;
}

function ceilingsViewOf(node: MobileNode, settings: DeviceSettings): CeilingsView {
  const current = ceilingsOf(settings);
  const standards = node.librarySettings.standards();
  const choices = Object.fromEntries(
    STAND_IN_CATEGORIES.map((c) => [c, ceilingChoices(standards[c], current[c])]),
  ) as Record<StandInCategory, number[]>;
  const canonical = Object.fromEntries(
    STAND_IN_CATEGORIES.map((c) => [c, standards[c].canonicalThreshold]),
  ) as Record<StandInCategory, number>;
  return { current, defaults: DEFAULT_SYNC_DOWN_CEILINGS.phone, choices, canonical };
}

/**
 * What this node is holding, and the sync-down ceilings that decide it.
 *
 * A hook of its own rather than a field on {@link LibraryState}, because the two
 * change for different reasons: the library changes when records arrive, and
 * this changes when *bytes* do. Folding them together would reload a grid of
 * sixty tiles every time a number moved.
 */
export function useStorage(node: NodeState): StorageState {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = node.status === "ready" ? node : null;

  const refresh = useCallback(() => {
    if (!ready) return;
    try {
      setReport(ready.node.storageReport());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [ready]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const [ceilings, setCeilings] = useState<CeilingsView | null>(null);
  useEffect(() => {
    setCeilings(ready ? ceilingsViewOf(ready.node, ready.node.deviceSettings()) : null);
  }, [ready]);

  const setCeiling = useCallback(
    (category: StandInCategory, ceiling: number | null) => {
      if (!ready) return;
      try {
        setCeilings(ceilingsViewOf(ready.node, ready.node.setCeilings({ [category]: ceiling })));
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    },
    [ready],
  );

  return {
    report,
    error,
    refresh,
    ceilings,
    setCeiling,
  };
}

/** The node's records, and the action that adds the camera roll to them. */
export function useLibrary(node: NodeState): LibraryState {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = node.status === "ready" ? node : null;

  /**
   * The cursor the next page starts from, and how many pages are loaded.
   *
   * Refs rather than state, and for two different reasons. The cursor must be
   * readable by a `loadMore` that a re-render has not yet been told about —
   * state would let two scroll events start from the same position and load the
   * same page twice. The page count is only ever read by a reload deciding how
   * much to restore, so making it state would re-render the grid for a number
   * nothing draws.
   */
  const cursor = useRef<string | null>(null);
  const pagesLoaded = useRef(1);
  /** Guards against a second `loadMore` starting while the first is in flight. */
  const loadingMoreRef = useRef(false);

  const depsFor = useCallback(
    (lease: NonNullable<typeof ready>) => ({
      database: lease.node.databaseAdapter,
      objectStorage: lease.node.objectStorage,
      aliases: lease.node.mediaAliases,
      // What lets a tile mark a Motion Photo. Null on a node with no device
      // media, which marks nothing and is the same answer as an unscanned
      // photograph.
      motionIndex: lease.node.motionIndex,
      // The library's settings, as this phone last received them.
      standards: () => lease.node.librarySettings.standards(),
    }),
    [],
  );

  /**
   * Read the library from the top, restoring however many pages were loaded.
   *
   * Restoring rather than resetting, because a reload is triggered by things
   * that have nothing to do with where somebody has scrolled to — an import
   * finished, a blob arrived, the screen was pulled down. Dropping them back to
   * the first page would be a worse bug than the stale tile the reload exists to
   * fix. See {@link MAX_RELOADED_PAGES} for where restoring stops being worth
   * the queries.
   */
  const reload = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      const deps = depsFor(ready);
      const limit = libraryPageSize();
      const grid = gridGeometry();
      const pages = Math.min(pagesLoaded.current, MAX_RELOADED_PAGES);

      const collected: LibraryItem[] = [];
      let next: string | null = null;
      let more = false;
      for (let page = 0; page < pages; page += 1) {
        const result: Awaited<ReturnType<typeof listLibrary>> = await listLibrary(deps, {
          limit,
          grid,
          ...(next ? { cursor: next } : {}),
        });
        collected.push(...result.items);
        next = result.nextCursor;
        more = result.hasMore;
        if (!more || !next) break;
      }

      cursor.current = next;
      pagesLoaded.current = Math.max(1, Math.ceil(collected.length / limit));
      setItems(collected);
      setHasMore(more && next !== null);
      setLoaded(true);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [ready, depsFor]);

  /**
   * Append the next page.
   *
   * Silent about its own failure on purpose: the grid already holds everything
   * loaded so far, and a red line under a working library because one more page
   * could not be read describes the wrong thing. The state simply does not
   * advance, and the next scroll to the bottom tries again.
   */
  const loadMore = useCallback(async () => {
    if (!ready || loadingMoreRef.current) return;
    const from = cursor.current;
    if (!from) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await listLibrary(depsFor(ready), {
        limit: libraryPageSize(),
        grid: gridGeometry(),
        cursor: from,
      });
      // Checked against the cursor this call started from. A reload that landed
      // while the page was in flight has already rewritten `items` and the
      // cursor, and appending to it would duplicate rows and lose the reload's.
      if (cursor.current !== from) return;
      cursor.current = page.nextCursor;
      pagesLoaded.current += 1;
      setItems((current) => [...current, ...page.items]);
      setHasMore(page.hasMore && page.nextCursor !== null);
      setLoadMoreError(null);
    } catch (err) {
      // `cursor.current` is left where it was, so the next attempt asks for the
      // same page rather than skipping it — and the reason is on screen, so a
      // grid that has stopped growing can be told apart from one that has
      // reached the end.
      setLoadMoreError(`Could not load more: ${String(err)}`);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [ready, depsFor]);

  /**
   * Re-derive one record's tile in place, leaving every other tile alone.
   *
   * The narrow answer to "something about this record changed", and the reason
   * {@link refreshLibraryItem} exists. Nothing about it is cheaper than a reload
   * per record — it runs the same queries — it is cheaper because it runs them
   * once instead of sixty times, and because `LibraryRow`'s comparator then
   * re-renders the one row holding the tile rather than every row on screen.
   *
   * A record the refresh cannot find is dropped from the page rather than left
   * as it was. Not finding it means it is gone — evicted, or removed by a sync
   * round — and a grid still drawing it would be drawing something the node no
   * longer holds.
   */
  const refreshItem = useCallback(
    async (recordId: StarkeepId) => {
      if (!ready) return;
      const fresh = await refreshLibraryItem(depsFor(ready), recordId, gridGeometry());
      setItems((current) => {
        const at = current.findIndex((candidate) => candidate.record.id === recordId);
        // Not on the loaded page any more, so there is nothing to patch. A
        // reload between the fetch and here is the ordinary way that happens.
        if (at < 0) return current;
        const next = current.slice();
        if (fresh) next[at] = fresh;
        else next.splice(at, 1);
        return next;
      });
    },
    [ready, depsFor],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const importQuietly = useCallback(async (): Promise<ImportOutcome | null> => {
    if (!ready) return null;
    try {
      // Read, never requested. The caller has already asked the same question to
      // decide whether to run this at all; asking again here is what keeps the
      // action safe for any other caller rather than safe by convention.
      const permission = await deviceMedia.getPermissions();
      if (!permission.granted) return null;

      const outcome = await importRecentFor(ready.node, ready.clock, {
        limit: FOREGROUND_IMPORT_LIMIT,
        background: false,
      });
      setError(null);
      await reload();
      return outcome;
    } catch (err) {
      setError(String(err));
      return null;
    }
  }, [ready, reload]);

  const backfillDurations = useCallback(async (): Promise<boolean> => {
    if (!ready) return true;
    try {
      const outcome = await backfillVideoDurationsFor(ready.node, {
        limit: VIDEO_DURATION_BACKFILL_LIMIT,
      });
      // Only when something changed. A pass that repaired nothing has moved no
      // tile, and reloading sixty of them for that is work nobody asked for.
      if (outcome.written > 0) await reload();
      return outcome.complete;
    } catch (err) {
      setError(String(err));
      // Stop asking. A pass that throws will throw again on the next app open,
      // and a repair that repeats its own failure forever is worse than a tile
      // that says "video".
      return true;
    }
  }, [ready, reload]);

  /**
   * Repair every still this device can reach, in batches, in one app open.
   *
   * **Runs to completion rather than one batch per launch, and the reason is
   * that a half-repaired library is ordered worse than an unrepaired one.** The
   * grid sorts by capture time with the unknowns bucketed at the end, so while
   * the repair is partial the records that happen to have a capture time float
   * above every record that does not — and on this app's own handset those were
   * fourteen videos and seven old photographs, which took the first twenty-one
   * slots of the grid and pushed a whole week of recent pictures below them.
   * Sequencing the ordering ahead of the repair is what produced that; making
   * the repair finish in one open is what stops the intermediate state from
   * being something anybody looks at.
   *
   * Affordable because a photograph is about a megabyte here, not the five the
   * batch size was first sized against: ninety of them is a second and a half of
   * transfer in total, spread across batches with a yield between each so the
   * screen keeps drawing.
   *
   * Bounded anyway. A camera roll is not bounded, and a loop that runs until a
   * media store says it is done is a loop that can run for a very long time on a
   * phone somebody is holding.
   */
  const backfillExif = useCallback(async (): Promise<boolean> => {
    if (!ready) return true;
    let written = 0;
    try {
      let after: string | null = null;
      for (let pass = 0; pass < MAX_EXIF_BACKFILL_PASSES; pass += 1) {
        const outcome = await backfillImageExifFor(ready.node, {
          limit: IMAGE_EXIF_BACKFILL_LIMIT,
          after,
        });
        written += outcome.written;
        if (outcome.complete) {
          // One reload at the end, not one per batch: every write moves a tile,
          // and reloading the grid ninety times to land in the same place is
          // work nobody asked for.
          if (written > 0) await reload();
          return true;
        }
        after = outcome.resumeAfter;
        // Between batches, so the thread this runs on can draw a frame. The same
        // argument the import loop makes about holding it for a whole batch.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      // Out of passes rather than out of work. Reload what was repaired and say
      // there is more; the next app open restarts the walk, which costs a
      // metadata read per batch and re-reads only the headers that answered
      // nothing.
      if (written > 0) await reload();
      return false;
    } catch (err) {
      setError(String(err));
      if (written > 0) await reload();
      // Stop asking, for the same reason the duration backfill does: a pass
      // that throws will throw again on the next app open, and a repair that
      // repeats its own failure forever is worse than a grid ordered by import
      // time.
      return true;
    }
  }, [ready, reload]);

  /**
   * Give a batch of records the placeholder they were imported without.
   *
   * Bounded by {@link MAX_THUMB_HASH_BACKFILL_PASSES} rather than run to
   * completion, unlike the EXIF walk beside it — see that constant for why the
   * two make opposite trades over the same walk.
   *
   * Reloads once at the end rather than per batch, on the argument every pass
   * here makes: a reload redraws the whole grid, and doing it ten times to land
   * in the same place is work nobody asked for.
   */
  const backfillThumbHashes = useCallback(async (): Promise<boolean> => {
    if (!ready) return true;
    let written = 0;
    try {
      let after: string | null = null;
      for (let pass = 0; pass < MAX_THUMB_HASH_BACKFILL_PASSES; pass += 1) {
        const outcome = await backfillThumbHashesFor(ready.node, {
          limit: THUMB_HASH_BACKFILL_LIMIT,
          after,
        });
        written += outcome.written;
        if (outcome.complete) {
          if (written > 0) await reload();
          return true;
        }
        after = outcome.resumeAfter;
        // Between batches, so the thread this runs on can draw a frame. It
        // matters more here than in the passes beside it: a batch is twelve full
        // decodes, and holding the thread across ten of them would be a visibly
        // frozen grid.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      // Out of passes rather than out of work. The next app open resumes from
      // the beginning of the walk, which costs a metadata read per batch and
      // decodes only the files that still answer nothing.
      if (written > 0) await reload();
      return false;
    } catch (err) {
      setError(String(err));
      if (written > 0) await reload();
      // Stop asking, for the reason the two passes beside it give: a pass that
      // throws will throw again on the next app open, and a repair that repeats
      // its own failure forever is worse than a tile with no placeholder.
      return true;
    }
  }, [ready, reload]);

  /**
   * Give a batch of videos the posters and capture time they were imported
   * without. Bounded by {@link MAX_EXIF_BACKFILL_PASSES}, the walk it shares a
   * shape with; a page that holds no video costs one query.
   */
  const backfillPosters = useCallback(async (): Promise<boolean> => {
    if (!ready) return true;
    let written = 0;
    try {
      let after: string | null = null;
      for (let pass = 0; pass < MAX_EXIF_BACKFILL_PASSES; pass += 1) {
        const outcome = await backfillVideoPostersFor(ready.node, ready.clock, {
          limit: VIDEO_POSTER_BACKFILL_LIMIT,
          after,
        });
        written += outcome.written;
        if (outcome.complete) {
          if (written > 0) await reload();
          return true;
        }
        after = outcome.resumeAfter;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (written > 0) await reload();
      return false;
    } catch (err) {
      setError(String(err));
      if (written > 0) await reload();
      // Stop asking: a pass that throws will throw again on the next open.
      return true;
    }
  }, [ready, reload]);

  /**
   * Make the rungs this device's own photographs are missing.
   *
   * One sweep per app open, bounded by {@link DERIVE_RECORDS_PER_OPEN}. It runs
   * last among the passes here for the same reason the ThumbHash backfill runs
   * after the two that decide where a tile *sits*: this improves what a tile
   * paints, and a grid in the wrong order is the worse problem.
   *
   * Reloads once at the end rather than per record, on the argument every pass
   * here makes: a reload redraws the whole grid, and doing it twelve times to
   * land in the same place is work nobody asked for.
   */
  const deriveRenditions = useCallback(async (): Promise<boolean> => {
    if (!ready) return true;
    try {
      const outcome = await deriveRenditionsFor(ready.node, ready.clock, {
        maxRecords: DERIVE_RECORDS_PER_OPEN,
      });
      // Null is a device that cannot derive at all — no camera roll, or a build
      // with no encoder in it. Stop asking; nothing about this app open will
      // change either.
      if (outcome === null) return true;
      if (outcome.written > 0) await reload();
      return outcome.complete;
    } catch (err) {
      setError(String(err));
      // Stop asking, for the reason every pass beside it gives: a sweep that
      // throws will throw again on the next open, and a repair that repeats its
      // own failure forever is worse than a library whose rungs arrive from
      // another node.
      return true;
    }
  }, [ready, reload]);

  const sweepNullModified = useCallback(async (): Promise<number> => {
    if (!ready) return 0;
    try {
      const outcome = await sweepNullModifiedFor(ready.node, ready.clock, {
        limit: NULL_MODIFIED_SWEEP_LIMIT,
      });
      // Only when something arrived. On almost every phone this pass finds
      // nothing, and reloading the grid for a pass that changed no record is
      // work nobody asked for — the same argument `backfillDurations` makes.
      if (outcome.imported > 0) await reload();
      return outcome.imported;
    } catch (err) {
      // Reported rather than swallowed: an asset that is invisible to the
      // ordinary walk is exactly the one whose failure nothing else would ever
      // mention.
      setError(String(err));
      return 0;
    }
  }, [ready, reload]);

  const openMotion = useCallback(
    async (item: LibraryItem): Promise<OpenMotionPhoto | null> => {
      if (!ready) return null;
      try {
        return await openMotionPhotoFor(ready.node, item.record);
      } catch {
        // Not reported on screen, deliberately. Most photographs have no motion
        // and the ones that do are a bonus on top of a still that is already
        // rendering; an error line here would attach a fault to a photograph
        // that is displaying perfectly.
        return null;
      }
    },
    [ready],
  );

  const deleteRecord = useCallback(
    async (record: DataRecord): Promise<void> => {
      if (!ready) return;
      const { cameraRollUris } = await deleteRecordFor(ready.node, ready.clock, record.id);
      // Before the trash dialog, so the item has left the grid and the viewer
      // whatever the person answers there.
      await reload();
      await trashCameraRollFiles(cameraRollUris);
    },
    [ready, reload],
  );

  const readInfo = useCallback(
    async (record: DataRecord): Promise<MetadataRow | null> => {
      if (!ready) return null;
      const category = typeCategory(record.type);
      if (category !== "image" && category !== "video") return null;
      try {
        const rows = await ready.node.databaseAdapter.getMetadataByIds(category, [record.id]);
        return rows.get(record.id) ?? null;
      } catch {
        // The sheet shows what the record itself carries without the row.
        return null;
      }
    },
    [ready],
  );

  const fetchBlob = useCallback(
    async (item: LibraryItem) => {
      if (!ready) return false;
      try {
        const ok = await ready.node.fetchBlob(item.record);
        if (!ok) {
          setError(
            ready.node.engine
              ? "Could not fetch those bytes. Check the connection and try again."
              : "This device is not signed in, so there is nowhere to fetch those bytes from.",
          );
          return false;
        }
        setError(null);
        // The one record, re-derived by the code a page is built from. The URI
        // is derived from the object store and there is exactly one path that
        // derives it — `refreshItem` runs that path over a single record rather
        // than over the whole loaded library.
        await refreshItem(item.record.id);
        return true;
      } catch (err) {
        setError(String(err));
        return false;
      }
    },
    [ready, refreshItem],
  );

  /**
   * One single-flight for the whole hook's lifetime.
   *
   * A ref rather than state, and created once rather than per render: the point
   * of it is that two callers meet, and a map rebuilt on every render is a map
   * nobody ever meets in.
   */
  const fetches = useRef(createInFlight({ limit: RENDITION_FETCH_CONCURRENCY }));

  const fetchRendition = useCallback(
    async (item: LibraryItem, surface: RenditionSurface): Promise<boolean> => {
      if (!ready) return false;
      const node = ready.node;
      // Nowhere to fetch from. Silent rather than reported, unlike `fetchBlob`:
      // that one is a button somebody pressed and this one is a surface deciding
      // for itself, so an error line would appear without anybody having asked
      // for anything.
      if (!node.engine) return false;

      // The tile's rule, and the only difference between the two surfaces. A
      // tile already painting a rung is showing a picture, and the step up to
      // the ideal is not worth a request during a scroll; the viewer asks
      // unconditionally, because there is one of it and somebody is looking at
      // it.
      if (surface === "tile" && item.paintedRendition !== null) return false;

      // The ordinary answer, and it is not a failure. The ideal rung is already
      // here, or nothing has derived it anywhere yet — and this fetch moves
      // bytes, it does not commission work.
      const renditionId = item.missingRendition;
      if (!renditionId) return false;

      try {
        return await fetches.current.run(`${item.record.id}:${renditionId}`, async () => {
          // Re-read at the point of use rather than trusting the id the caller
          // resolved from: a rendition record can arrive, or be superseded,
          // between the resolution and this call.
          const rendition = await node.databaseAdapter.get(renditionId);
          if (!rendition || rendition.deletedAt) return false;
          // `fetchBlob` takes a `DataRecord` and a rendition *is* one — same
          // key, same content hash, same size. No new transport and no new API.
          const ok = await node.fetchBlob(rendition);
          if (ok) {
            // The one record, re-derived by the same code a page is built from
            // — which is the whole of what `fetchBlob`'s reload was after. A
            // reload here re-derived the entire loaded library to change one
            // tile, cost 5.8 s of held JavaScript thread on a Pixel 5, and
            // restarted the prefetch loop that had asked for these very bytes.
            await refreshItem(item.record.id);
          }
          return ok;
        });
      } catch (err) {
        // Reported but not fatal to the surface. What is on screen is whatever
        // already resolved — a smaller rung, the original, or the ThumbHash —
        // which is a working grid rather than a broken one.
        setError(String(err));
        return false;
      }
    },
    [ready, refreshItem],
  );

  /**
   * One derivation at a time, for the lifetime of the hook.
   *
   * Separate from {@link fetches} rather than sharing its pool, because the two
   * bound different resources and a shared queue would let a cold grid's encodes
   * sit in front of the download somebody is waiting on. See
   * `RENDITION_DERIVE_CONCURRENCY`.
   */
  const derivations = useRef(createInFlight({ limit: RENDITION_DERIVE_CONCURRENCY }));

  const deriveNow = useCallback(
    async (
      item: LibraryItem,
      surface: RenditionSurface,
      ceilingLongEdge?: number,
    ): Promise<boolean> => {
      if (!ready) return false;
      const node = ready.node;
      const clock = ready.clock;
      // **The tile's rule, and the only difference between the two surfaces.**
      // A tile already painting a rung is showing a picture, and the step up to
      // the ideal is not worth the most expensive call in the app during a
      // scroll. The viewer asks anyway: there is one of it, somebody opened it
      // deliberately, and the rung it wants is usually one the sweep's ceiling
      // forbids — so refusing here is what used to leave a full screen painting
      // a 640 px tile rung with a 12-megapixel original sitting in the camera
      // roll, waiting on a network round trip for pixels already on the device.
      if (surface === "tile" && item.paintedRendition !== null) return false;
      // A rung exists somewhere and its bytes do not. That is a fetch, and
      // deriving here would mint a second record for the same rung — see
      // `deriveForRecord`. True for both surfaces: the viewer may raise the
      // ceiling, and may not re-encode a class that already has a record.
      if (item.missingRendition !== null) return false;
      // Nothing on this device to decode. Checked here as well as inside
      // `deriveForRecord` so the ordinary synced record costs no query at all.
      if (!item.bytesHere) return false;

      try {
        // Keyed on the ceiling as well as the record. The two surfaces ask for
        // genuinely different work on one photograph — the sweep's rungs and the
        // stage's — and collapsing them onto one key would make the viewer's
        // request resolve to whatever the grid had already queued.
        return await derivations.current.run(`${item.record.id}:${ceilingLongEdge ?? ""}`, async () => {
          const written = await deriveRecordFor(node, clock, item.record, ceilingLongEdge);
          if (written === null || written === 0) return false;
          // The one record, through the same code a page is built from. A
          // reload here would re-resolve every loaded tile to change this one,
          // which on a Pixel 5 is 5.8 s of held JavaScript thread — and this
          // pass fires once per undived record in a cold library.
          await refreshItem(item.record.id);
          return true;
        });
      } catch (err) {
        // One photograph that would not encode. Reported, because unlike a
        // fetch there is no network to blame and a device failing to decode its
        // own camera roll is worth knowing about — but not fatal: the tile keeps
        // its placeholder and every other record still derives.
        setError(String(err));
        return false;
      }
    },
    [ready, refreshItem],
  );

  /**
   * The item as the viewer should paint it, resolved at the viewer's own size.
   *
   * Resolves the item unchanged when the node is not ready, so the viewer opens
   * on the tile's answer rather than on nothing. That is a worse picture and not
   * a broken one, which is the right way to degrade for a surface somebody has
   * just tapped.
   */
  const openForViewer = useCallback(
    async (item: LibraryItem, stage: Box): Promise<LibraryItem> => {
      if (!ready) return item;
      try {
        return await resolveForViewer(depsFor(ready), item, {
          // The viewer's own box, handed in by the surface that lays it out.
          // Read from `Dimensions.get("window")` here until the stage became a
          // stated number, which meant this asked about a screen while the
          // style sheet laid out a stage and the two disagreed by the height of
          // the footer.
          stage,
          devicePixelRatio: PixelRatio.get(),
        });
      } catch (err) {
        setError(String(err));
        return item;
      }
    },
    [ready, depsFor],
  );

  /**
   * What this run has already gone after, whether by fetching or by deriving.
   *
   * A record of *attempts*, not of successes, and it is what stops a failure
   * from being retried on every reload. A rendition that arrives makes its own
   * repeat impossible — the next page resolves it as resident and reports
   * nothing missing — so the only thing this changes is the failing case, which
   * waits for the next launch or for the viewer's own control rather than
   * hammering.
   *
   * **Two kinds of key in one set, and they cannot collide.** A fetch is keyed
   * on the rendition record's id and a derivation on the parent record's, and a
   * record is never both — see the effect below. One set rather than two because
   * the question it answers is the same one for both: has this run already tried
   * to make this tile paint?
   *
   * A ref and not state: nothing on screen depends on it, and setting state here
   * would re-render the grid for a bookkeeping entry.
   */
  const attempted = useRef(new Set<string>());

  /**
   * Give this page the rungs it needs to paint: fetch what exists, make what
   * does not.
   *
   * ## Why this fires from the page and not from the tile
   *
   * A tile is a row of a virtualized list: it mounts and unmounts every time it
   * crosses the viewport, so an effect inside one fires per tile *per scroll*.
   * That is precisely the request storm the fetch rule exists to avoid. The page
   * changes when records do, which is the honest trigger — and it bounds the
   * work to one page's worth however far somebody flicks.
   *
   * ## The two branches, and why a record is only ever in one
   *
   * `missingRendition` is non-null exactly when the rendition **record** exists
   * and its blob does not — metadata sync brought the row down from a node that
   * derived it, or this device evicted the bytes. That is a transfer, and
   * {@link fetchRendition} is what does it.
   *
   * Null with nothing painted is the opposite state: no rung exists anywhere, so
   * there is nothing to fetch and the answer is to make one. On a phone showing
   * its own camera roll that is nearly every record, and until {@link deriveNow}
   * this branch did not exist — the loop skipped those records entirely and the
   * only thing that would ever derive them was a cursor sweep in content-hash
   * order, twelve records to an app open. That is what made the grid decode
   * originals: not the paint rule, but that nothing ever asked for the rungs the
   * paint rule wanted.
   *
   * The two are mutually exclusive by construction, so this is a branch and not
   * a fallthrough — and getting it wrong in the other direction is the expensive
   * mistake, since deriving a rung that already has a record mints a second
   * record for it.
   *
   * ## Why the order is the page's order
   *
   * Both pools are FIFO and this loop walks `items`, which is the order the grid
   * lays tiles out. So a cold library resolves from the top down, which is where
   * somebody is looking, rather than in whatever order a content hash happens to
   * sort.
   */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      for (const item of items) {
        if (cancelled) return;
        // The rule, stated once: only a tile with *no* resident rung at all.
        // A tile already painting a smaller rung is showing a picture, and the
        // difference between it and the ideal is not worth a request — or an
        // encode — during a scroll.
        if (item.paintedRendition !== null) continue;

        // Keyed on the record rather than on a rendition id, because in this
        // branch there is no rendition to name yet. Attempts and not successes,
        // for the reason the fetch side gives: a record that derives makes its
        // own repeat impossible, so this only bounds the failing case.
        if (item.missingRendition === null) {
          if (attempted.current.has(item.record.id)) continue;
          attempted.current.add(item.record.id);
          await deriveNow(item, "tile");
          continue;
        }

        if (attempted.current.has(item.missingRendition)) continue;
        attempted.current.add(item.missingRendition);
        // Awaited in sequence rather than fired in parallel. The concurrency cap
        // would hold either way, but a loop that awaits leaves the thread between
        // records instead of queueing a page's worth in one frame.
        await fetchRendition(item, "tile");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, items, fetchRendition, deriveNow]);

  return {
    items,
    loading,
    loaded,
    loadingMore,
    hasMore,
    loadMoreError,
    error,
    reload,
    loadMore,
    importQuietly,
    backfillDurations,
    backfillExif,
    backfillThumbHashes,
    backfillPosters,
    deriveRenditions,
    sweepNullModified,
    openMotion,
    readInfo,
    captions: ready?.node.captions ?? null,
    deleteRecord,
    fetchBlob,
    fetchRendition,
    deriveNow,
    openForViewer,
  };
}
