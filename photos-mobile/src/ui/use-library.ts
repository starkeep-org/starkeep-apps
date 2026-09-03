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
import { createHLCClock, type HLCClock } from "@starkeep/protocol-primitives";
import { listLibrary, summarizeLibrary, type LibraryItem, type LibrarySummary } from "../library";
import {
  IMAGE_EXIF_BACKFILL_LIMIT,
  importDeviceMedia,
  NULL_MODIFIED_SWEEP_LIMIT,
  type ImportOutcome,
  type ImportProgress,
} from "../media/import";
import type { NodeIdentity } from "../node-identity";
import type { DeviceKey } from "../auth/device-key";
import type { MobileNode, StorageReport } from "../node";
import type { EvictionOutcome } from "@starkeep/sync-engine";
import {
  backfillImageExifFor,
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
import { CONTENT_PADDING, GRID_COLUMNS, GRID_GAP, TILE_WIDTH_FRACTION } from "./theme";

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
  const gridWidth = window.width - CONTENT_PADDING * 2;
  const rowHeight = gridWidth * TILE_WIDTH_FRACTION + GRID_GAP;
  const rowsOnScreen = Math.ceil(window.height / rowHeight);
  const tiles = rowsOnScreen * 2 * GRID_COLUMNS;
  const clamped = Math.min(Math.max(tiles, 30), 90);
  return Math.ceil(clamped / GRID_COLUMNS) * GRID_COLUMNS;
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
 * The pixel long edge one grid tile wants.
 *
 * ## Pixels, never a class name
 *
 * The same contract every other Photos surface uses. A caller states what it
 * needs in the only unit it actually knows — how many pixels it is about to
 * paint — and the ladder decides which rung answers. That is what let
 * `35d849d` respecify two rungs without touching a single consumer, and naming
 * `image-thumb` here would put this file back in the set that has to change.
 *
 * ## Where the number comes from
 *
 * The layout in `theme.ts`: `styles.content` pads 20 each side and
 * `styles.tile` takes 32.8% of what is left, three across. Multiplying by the
 * device pixel ratio converts the result from layout points to the pixels the
 * decoder will actually fill.
 *
 * Computed rather than measured with `onLayout`, because the grid is a fixed
 * three columns and the arithmetic above is the whole of its geometry. The web
 * app measures because a justified layout has no such closed form. If this grid
 * ever gains one, this is the function to replace with a real measurement.
 *
 * Read at query time rather than cached, so a rotation is picked up by the next
 * reload without a listener.
 */
function tileLongEdge(): number {
  const gridWidth = Dimensions.get("window").width - CONTENT_PADDING * 2;
  return Math.round(gridWidth * TILE_WIDTH_FRACTION * PixelRatio.get());
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
      const edge = tileLongEdge();
      const pages = Math.min(pagesLoaded.current, MAX_RELOADED_PAGES);

      const collected: LibraryItem[] = [];
      let next: string | null = null;
      let more = false;
      for (let page = 0; page < pages; page += 1) {
        const result: Awaited<ReturnType<typeof listLibrary>> = await listLibrary(deps, {
          limit,
          tileLongEdge: edge,
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
        tileLongEdge: tileLongEdge(),
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
    sweepNullModified,
    openMotion,
    fetchBlob,
    setPinned,
    isPinned,
    noteOpened,
  };
}
