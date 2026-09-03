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
  createHLCClock,
  typeCategory,
  type HLCClock,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  listLibrary,
  resolveForViewer,
  summarizeLibrary,
  type LibraryItem,
  type LibrarySummary,
} from "../library";
import {
  IMAGE_EXIF_BACKFILL_LIMIT,
  importDeviceMedia,
  NULL_MODIFIED_SWEEP_LIMIT,
  type ImportOutcome,
  type ImportProgress,
} from "../media/import";
import { THUMB_HASH_BACKFILL_LIMIT } from "../media/thumb-hash";
import type { NodeIdentity } from "../node-identity";
import type { DeviceKey } from "../auth/device-key";
import type { MobileNode, StorageReport } from "../node";
import type { EvictionOutcome } from "@starkeep/sync-engine";
import {
  backfillImageExifFor,
  backfillThumbHashesFor,
  backfillVideoDurationsFor,
  deviceMedia,
  discardNodeFiles,
  importDepsFor,
  importRecentFor,
  openMotionPhotoFor,
  sweepNullModifiedFor,
} from "../platform";
import type { OpenMotionPhoto } from "../media/motion-photo-playback";
import { acquireNode, closeNodeForReset, type NodeLease } from "../work/node-handle";
import { CONTENT_PADDING, GRID_GAP, LIBRARY_ROW_HEIGHT } from "./theme";
import { viewerTarget, type GridGeometry } from "../photos/render-target";
import { createInFlight, RENDITION_FETCH_CONCURRENCY } from "../work/in-flight";

/**
 * Which surface is asking for a rendition.
 *
 * The two differ in size and in when they fire, and both differences matter
 * enough to name rather than to pass a number for.
 *
 * A **tile** wants a box in a justified row, and the page already resolved what
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
 * decoder can keep up with in a single burst. Rounded to a multiple of three
 * because the grid is three columns and a partial trailing row is a ragged edge
 * mid-list.
 */
export function libraryPageSize(): number {
  const window = Dimensions.get("window");
  const rowHeight = LIBRARY_ROW_HEIGHT + GRID_GAP;
  const rowsOnScreen = Math.ceil(window.height / rowHeight);
  const tiles = rowsOnScreen * 2 * nominalItemsPerRow(window.width);
  return Math.round(Math.min(Math.max(tiles, 30), 90));
}

/**
 * Roughly how many photographs a justified row holds, for paging arithmetic.
 *
 * **An estimate, and it has to be, which is the difference from the three
 * columns this replaced.** A justified row's length depends on the shapes it is
 * given: a row of portraits holds more than a row of landscapes, and the
 * layout only knows how many once it has the records — which is the thing the
 * page size is being computed to fetch.
 *
 * So it is estimated from the same mild landscape guess a record with unknown
 * dimensions gets. Being wrong costs a fraction of a screen either way, and the
 * clamp above bounds both directions.
 *
 * Nothing rounds the result to a whole row any more, and nothing should: rows
 * are not a fixed length, so there is no ragged trailing row to avoid.
 */
function nominalItemsPerRow(windowWidth: number): number {
  const gridWidth = windowWidth - CONTENT_PADDING * 2;
  const nominalTileWidth = LIBRARY_ROW_HEIGHT * UNKNOWN_ASPECT_ESTIMATE + GRID_GAP;
  return Math.max(1, gridWidth / nominalTileWidth);
}

/**
 * The shape assumed for a photograph nobody has measured.
 *
 * The same 1.5 the shared layout guesses with, restated here rather than
 * imported because `__tests__/ladder-boundary.test.ts` keeps this file out of
 * `@starkeep/photos-ladder` and routing a paging estimate through the Photos
 * layer would be ceremony for one number. It feeds an estimate, never a layout:
 * the rows themselves are laid out from each record's real aspect ratio.
 */
const UNKNOWN_ASPECT_ESTIMATE = 1.5;

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
 * This used to answer one `tileLongEdge` for a whole page — 32.8% of the padded
 * width, three across, times the device pixel ratio. That was a closed form over
 * a fixed square grid, and the grid is no longer either: a justified row gives
 * every photograph a box of its own shape, so the pixel count is per record and
 * has to be derived from the shape.
 *
 * What travels instead is the geometry the layout will use, and
 * `photos/render-target.ts` turns it into a request per record. The unit at that
 * boundary is still pixels and never a class name — the contract every Photos
 * surface shares, and what lets the ladder be respecified without touching a
 * caller.
 *
 * ## Still computed rather than measured
 *
 * Every input is known before layout runs: the window, the padding `theme.ts`
 * owns, and the row height it names. An `onLayout` here would report a number
 * this already has, one frame later. The web app's viewer makes the same
 * argument about its own stage.
 *
 * Read at query time rather than cached, so a rotation is picked up by the next
 * reload without a listener.
 */
function gridGeometry(): GridGeometry {
  return {
    targetRowHeight: LIBRARY_ROW_HEIGHT,
    containerWidth: Dimensions.get("window").width - CONTENT_PADDING * 2,
    devicePixelRatio: PixelRatio.get(),
  };
}

/** How many assets one import pass considers. */
export const IMPORT_BATCH = 60;

/**
 * How many assets a foreground catch-up considers.
 *
 * Sixty, matching {@link IMPORT_BATCH} rather than the background tick's twenty.
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

export type NodeState =
  | { readonly status: "starting" }
  | {
      readonly status: "ready";
      readonly node: MobileNode;
      readonly identity: NodeIdentity;
      readonly clock: HLCClock;
      /** Shown on screen so the operator can pair this device in admin-web. */
      readonly deviceKey: DeviceKey;
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
   * Delete everything this node has indexed and open a fresh one.
   *
   * Resolves once the replacement is up, so a caller can reload immediately
   * afterwards without racing the node it is about to query.
   */
  reset: () => Promise<void>;
}

export function useNode(): NodeHandle {
  const [state, setState] = useState<NodeState>({ status: "starting" });
  /** Bumped to force the effect to build a new node after a reset. */
  const [generation, setGeneration] = useState(0);
  const current = useRef<MobileNode | null>(null);
  /** Resolved by the effect once the post-reset node is up. */
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
          deviceKey: acquired.deviceKey,
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

  const reset = useCallback(async () => {
    if (!current.current) return;
    current.current = null;
    setState({ status: "starting" });
    // Close the shared node before deleting its files, and in that order:
    // SQLite holds the database open, and removing it underneath a live
    // connection is how one ends up half-there. Every outstanding claim is
    // invalidated by the close, which is the honest shape of the operation —
    // the thing they hold a claim on is being deleted.
    await closeNodeForReset();
    discardNodeFiles();

    // Wait for the effect's replacement rather than building one here: two code
    // paths creating nodes is two code paths that can disagree about how, and
    // the effect already owns the lifecycle including cleanup.
    const built = new Promise<void>((resolve) => {
      opening.current = resolve;
    });
    setGeneration((n) => n + 1);
    await built;
  }, []);

  return { state, reset };
}

export interface LibraryState {
  readonly items: readonly LibraryItem[];
  readonly summary: LibrarySummary | null;
  readonly loading: boolean;
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
  /** An import somebody asked for by tapping the button. */
  readonly importing: boolean;
  /**
   * An automatic import, started because the app came to the foreground.
   *
   * Carried apart from {@link importing} because the two need different words
   * on screen. A tap is a request and deserves a count against a total; a
   * catch-up is the app doing its job and deserves one muted line that does not
   * make the button it did not come from look busy.
   */
  readonly catchingUp: boolean;
  readonly lastImport: ImportOutcome | null;
  /** Non-null only while an import is running, whichever kind. */
  readonly progress: ImportProgress | null;
  readonly error: string | null;
  reload: () => Promise<void>;
  /**
   * Append the next page, if there is one.
   *
   * Safe to call on every scroll event: a call with nothing left to load, or
   * with a load already in flight, resolves without doing anything.
   */
  loadMore: () => Promise<void>;
  importNow: () => Promise<void>;
  /**
   * Import without asking for anything.
   *
   * The automatic half of the foreground catch-up. Two differences from
   * {@link importNow}, and both are what make it safe to run unprompted:
   *
   * 1. It reads the media permission rather than requesting it. A system dialog
   *    raised because somebody opened the app has asked for something before
   *    saying what for.
   * 2. It passes the import watermark, so a pass on a quiet phone asks the media
   *    store for nothing and costs nothing. "Add photos from this device" still
   *    runs without one, because backfilling a library that predates this node
   *    is exactly what a watermark prevents. See `ImportDeps.importCursor`.
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
   * The item as the viewer should paint it, resolved at the viewer's own size.
   *
   * Called on open and again after a fetch lands. The second call is what stops
   * the viewer from reporting bytes as absent once they have arrived — it holds
   * the item it was opened with, and nothing else would tell it otherwise. See
   * `resolveForViewer`.
   */
  openForViewer: (item: LibraryItem) => Promise<LibraryItem>;
  /**
   * Run an eviction pass, because a viewing burst just ended.
   *
   * The viewer's close is when a person stops asking for bytes, so it is the
   * moment nothing is waiting on the disk — which makes it the cheapest time to
   * spend it. `SyncEngine.fetchBlob` deliberately charges bytes on arrival
   * without asking whether they fit, so a burst of opens leaves the budget over
   * and this is what brings it back.
   */
  reclaimAfterViewing: () => Promise<void>;
  /** Pin or release a record on this device. Returns the state afterwards. */
  setPinned: (recordId: string, pinned: boolean) => boolean;
  isPinned: (recordId: string) => boolean;
  /** Someone opened this record. Feeds the recency rules and eviction order. */
  noteOpened: (recordId: string) => void;
}

/** What the Storage section shows, and the action that changes it. */
export interface StorageState {
  readonly report: StorageReport | null;
  readonly reclaiming: boolean;
  /** Result of the last pass, for the line under the button. */
  readonly lastPass: readonly EvictionOutcome[] | null;
  readonly error: string | null;
  refresh: () => void;
  reclaim: () => Promise<void>;
}

/**
 * What this node is holding against what its policy allows, and the action that
 * brings the two back together.
 *
 * A hook of its own rather than a field on {@link LibraryState}, because the two
 * change for different reasons: the library changes when records arrive, and
 * this changes when *bytes* do. Folding them together would reload a grid of
 * sixty tiles every time an eviction pass moved a number.
 */
export function useStorage(node: NodeState): StorageState {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [reclaiming, setReclaiming] = useState(false);
  const [lastPass, setLastPass] = useState<readonly EvictionOutcome[] | null>(null);
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

  const reclaim = useCallback(async () => {
    if (!ready) return;
    setReclaiming(true);
    try {
      const outcomes = await ready.node.reclaimSpace();
      setLastPass(outcomes);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setReclaiming(false);
      refresh();
    }
  }, [ready, refresh]);

  return { report, reclaiming, lastPass, error, refresh, reclaim };
}

/** The node's records, and the action that adds the camera roll to them. */
export function useLibrary(node: NodeState): LibraryState {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  const [lastImport, setLastImport] = useState<ImportOutcome | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
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

      const totals = await summarizeLibrary(deps);
      cursor.current = next;
      pagesLoaded.current = Math.max(1, Math.ceil(collected.length / limit));
      setItems(collected);
      setHasMore(more && next !== null);
      setSummary(totals);
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

  useEffect(() => {
    void reload();
  }, [reload]);

  const importNow = useCallback(async () => {
    if (!ready) return;
    setImporting(true);
    try {
      const deps = importDepsFor(ready.node, ready.clock);

      // Permission is requested here rather than on mount, because this is the
      // point at which the user has asked for something that needs it. A system
      // dialog thrown at someone before they have done anything has asked for
      // something before saying what for.
      const permission = await deps.media.requestPermissions();
      if (!permission.granted) {
        setError("Starkeep needs access to your photos to add them to this device's library.");
        return;
      }

      setLastImport(
        await importDeviceMedia(
          {
            ...deps,
            onProgress: (p) => {
              setProgress(p);
              // Also to logcat, because the on-screen line is a summary and the
              // per-asset split between "pulling bytes across JSI" and "hashing
              // them in JavaScript" is what says which one to go and fix.
              console.log(
                `[starkeep:import] ${p.done}/${p.total} ${p.filename ?? "?"} ` +
                  `${p.sizeBytes}B read=${p.readMs}ms hash=${p.hashMs}ms`,
              );
            },
          },
          { limit: IMPORT_BATCH },
        ),
      );
      setProgress(null);
      setError(null);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setImporting(false);
    }
  }, [ready, reload]);

  const importQuietly = useCallback(async (): Promise<ImportOutcome | null> => {
    if (!ready) return null;
    setCatchingUp(true);
    try {
      // Read, never requested. The caller has already asked the same question to
      // decide whether to run this at all; asking again here is what keeps the
      // action safe for any other caller rather than safe by convention.
      const permission = await deviceMedia.getPermissions();
      if (!permission.granted) return null;

      const outcome = await importRecentFor(ready.node, ready.clock, {
        limit: FOREGROUND_IMPORT_LIMIT,
        background: false,
        onProgress: setProgress,
      });
      setLastImport(outcome);
      setProgress(null);
      setError(null);
      await reload();
      return outcome;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setCatchingUp(false);
      setProgress(null);
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
        // Reload rather than patching the one item: the URI is derived from the
        // object store, so the grid re-deriving it is the same code path that
        // produced the placeholder — and there is exactly one of it.
        await reload();
        return true;
      } catch (err) {
        setError(String(err));
        return false;
      }
    },
    [ready, reload],
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
          if (!rendition) return false;
          // `fetchBlob` takes a `DataRecord` and a rendition *is* one — same
          // key, same content hash, same size. No new transport and no new API.
          const ok = await node.fetchBlob(rendition);
          if (ok) {
            // Reload rather than patching the one item, for the reason
            // `fetchBlob` gives: the URI is derived from the object store, so
            // the grid re-deriving it is the same code path that produced the
            // placeholder, and there is exactly one of it.
            await reload();
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
    [ready, reload],
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
    async (item: LibraryItem): Promise<LibraryItem> => {
      if (!ready) return item;
      const screen = Dimensions.get("window");
      try {
        return await resolveForViewer(depsFor(ready), item, {
          screen: { width: screen.width, height: screen.height },
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
   * Renditions this run has already gone looking for.
   *
   * A record of *attempts*, not of successes, and it is what stops a failing
   * fetch from being retried on every reload. A rendition that arrives makes its
   * own repeat impossible — the next page resolves it as resident and reports
   * nothing missing — so the only thing this changes is the failing case, which
   * waits for the next launch or for the viewer's own fetch control rather than
   * hammering.
   *
   * A ref and not state: nothing on screen depends on it, and setting state here
   * would re-render the grid for a bookkeeping entry.
   */
  const attempted = useRef(new Set<string>());

  /**
   * Go and get the rungs this page is missing.
   *
   * ## Why this fires from the page and not from the tile
   *
   * A tile is a row of a virtualized list: it mounts and unmounts every time it
   * crosses the viewport, so an effect inside one fires per tile *per scroll*.
   * That is precisely the request storm the fetch rule exists to avoid. The page
   * changes when records do, which is the honest trigger — and it bounds the
   * work to one page's worth however far somebody flicks.
   *
   * ## Why the volume is small in practice
   *
   * `missingRendition` is non-null only when the rendition **record** exists and
   * its blob does not, which means metadata sync brought the row down from a
   * node that derived it. A phone showing its own camera roll before anything
   * has been derived has no rendition records at all, so this fires for nothing.
   * The case it serves is a library synced from elsewhere, where the rungs are
   * exactly what the phone wants and exactly what it has not got.
   */
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      for (const item of items) {
        if (cancelled) return;
        // The rule, stated once: only a tile with *no* resident rung at all.
        // A tile already painting a smaller rung is showing a picture, and the
        // difference between it and the ideal is not worth a request during a
        // scroll.
        if (item.paintedRendition !== null || item.missingRendition === null) continue;
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
  }, [ready, items, fetchRendition]);

  /**
   * Give the budget back after a viewing burst.
   *
   * Errors are swallowed, and that is the difference from the Storage screen's
   * own reclaim button. That one is a person asking what happened; this fires on
   * closing a photograph, and a red line appearing under the grid because a
   * housekeeping pass failed would describe the wrong thing entirely.
   */
  const reclaimAfterViewing = useCallback(async () => {
    if (!ready) return;
    try {
      await ready.node.reclaimSpace();
    } catch {
      // The next pass — a tick's, or the Storage button's — runs the same rule.
    }
  }, [ready]);

  const setPinned = useCallback(
    (recordId: string, pinned: boolean) => {
      if (!ready) return false;
      ready.node.setPinned(recordId, pinned);
      return ready.node.isPinned(recordId);
    },
    [ready],
  );

  const isPinned = useCallback(
    (recordId: string) => ready?.node.isPinned(recordId) ?? false,
    [ready],
  );

  const noteOpened = useCallback(
    (recordId: string) => ready?.node.noteOpened(recordId),
    [ready],
  );

  return {
    items,
    summary,
    loading,
    loadingMore,
    hasMore,
    loadMoreError,
    importing,
    catchingUp,
    lastImport,
    progress,
    error,
    reload,
    loadMore,
    importNow,
    importQuietly,
    backfillDurations,
    backfillExif,
    backfillThumbHashes,
    sweepNullModified,
    openMotion,
    fetchBlob,
    fetchRendition,
    openForViewer,
    reclaimAfterViewing,
    setPinned,
    isPinned,
    noteOpened,
  };
}
