/**
 * The work this app does while it is open: import what the camera roll gained,
 * sync, derive the sizes this device's own photographs need, and register the
 * background window that does the same while it is closed.
 *
 * Moved out of `HomeScreen` when the screen stopped being the only thing on
 * screen. Settings opens over the grid and needs "Sync now", and the work must
 * keep running whatever the person is looking at — so it belongs to neither
 * screen, and both read it from here.
 *
 * Nothing in here draws anything. What a person sees of it is whether a sync is
 * running and why the last one stopped short, and nothing else: the progress
 * counters, the trace and the catch-up description were diagnostics and are
 * gone with the panel that showed them.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking } from "react-native";
import { deviceMedia, mediaLocationGranted } from "../platform";
import { shouldAskForMediaLocation } from "../media/original-uri";
import { describeAccess, nextAccessStep, type MediaAccess } from "../media/device-library";
import { planCatchUp } from "../work/foreground-catchup";
import {
  createDebouncer,
  createForegroundSyncLoop,
  createSyncFollowUp,
  mayAutoSync,
} from "../work/foreground-sync";
import type { SyncTrigger } from "../work/sync-trace";
import { readRealDeviceState, registerBackgroundWork } from "../work/background-task";
import type { LibraryState, NodeState, StorageState } from "./use-library";

export interface ForegroundWork {
  /** True while a sync is running. */
  readonly syncing: boolean;
  /** Why the last sync stopped short of finishing, or null when it did not. */
  readonly syncError: string | null;
  /**
   * A sync a person asked for. Unconstrained, unlike the automatic ones: a tap
   * is a person deciding to spend their own data, so it does not wait for
   * Wi-Fi.
   */
  syncNow: () => void;
  /**
   * The open-the-app pass, on demand: import, then sync under the automatic
   * rule. Pull-to-refresh calls it, and skips the interval guard, because a
   * person pulling is asking for exactly this now.
   */
  catchUpNow: () => Promise<void>;
  /** Whether this app may read the camera roll; null until asked. */
  readonly mediaAccess: MediaAccess | null;
  /**
   * Ask for the camera roll again: the system dialog when Android will still
   * show one, the app's system settings page when it will not.
   */
  requestMediaAccess: () => Promise<void>;
}

export function useForegroundWork(
  node: NodeState,
  library: LibraryState,
  storage: StorageState,
): ForegroundWork {
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  /**
   * Aborts the running sync when this screen goes away or the app leaves the
   * foreground.
   *
   * A tap starts an unbounded drain — a first upload of a real library is
   * hundreds of rounds and can run for as long as the OS lets it. Without a
   * signal, backgrounding the app left that loop issuing requests until the
   * platform froze the process mid-round, which is the one way to stop it that
   * nobody chose. `sync()` checks the signal between rounds and returns what it
   * has, and every round has already persisted its own watermarks, so stopping
   * costs at most the round in flight and the next tap resumes in place.
   */
  const syncAbort = useRef<AbortController | null>(null);
  /** True while a sync is in flight, readable from an event handler. */
  const syncingRef = useRef(false);
  /**
   * At most one sync running and one waiting behind it. A sync asked for while
   * one runs — the rungs a derivation just made, a photograph imported a
   * moment ago — runs when that one ends instead of being dropped. See
   * `work/foreground-sync.ts`.
   */
  const syncFollowUp = useRef(createSyncFollowUp());
  /** What asked for the waiting follow-up, for the trace. The latest wins. */
  const followUpTrigger = useRef<SyncTrigger>("button");
  /** Whether the app is in the foreground, readable from a sync's `finally`. */
  const appActive = useRef(AppState.currentState === "active");
  /** When the last catch-up that actually ran finished. Feeds the interval guard. */
  const catchUpAt = useRef<number | null>(null);
  /** True while a catch-up is deciding or importing, so two cannot overlap. */
  const catchingUpRef = useRef(false);
  /**
   * Whether the duration backfill has reached the end of the camera roll.
   *
   * A ref rather than persisted state, because the pass's own watermark is what
   * persists: this only stops the *repeat asking* within one run of the app, and
   * a relaunch that asks once more costs one media-store query that answers
   * empty. See `backfillVideoDurations`.
   */
  const durationsBackfilled = useRef(false);
  /** Same, for the stills' capture time and orientation. */
  const exifBackfilled = useRef(false);
  const postersBackfilled = useRef(false);
  /** Same, for the placeholder every record paints before its bytes resolve. */
  const thumbHashesBackfilled = useRef(false);
  /**
   * Same, for the rungs this device makes for its own photographs.
   *
   * The one flag here that a completed pass does not settle for good. The others
   * repair a fact about a record that was already imported, so "nothing left"
   * stays true; a derivation sweep that reaches the end of the roll is only
   * current until the next photograph is taken. Its own cursor resets on
   * completion, so a later app open walks again. See `photos/derive-ladder.ts`.
   */
  const renditionsDerived = useRef(false);

  /**
   * Run a sync, from a tap or from a foreground catch-up.
   *
   * Extracted from the button so the two callers are the same code. A catch-up
   * sync that differed from a tapped one would be a second implementation of
   * the only path that matters on this screen, and the difference would show up
   * exactly once, on a handset, as a library that stopped halfway.
   *
   * **The button is the unconstrained one.** A catch-up decides whether the
   * connection allows an upload before it gets here (see `planCatchUp`); a tap
   * does not, because a tap is a person deciding to spend their own data.
   *
   * `sync()`, not `exchange()`: a round carries at most one round's budget, so
   * one tap per round would make a first upload of a real library hundreds of
   * taps.
   */
  const startSyncRef = useRef<((trigger: SyncTrigger) => void) | null>(null);
  const runSync = useCallback(
    (trigger: SyncTrigger = "button") => {
      if (node.status !== "ready" || node.node.engine === null) return;
      // A catch-up, a timer tick and a tap can race — the app comes back to the
      // foreground while a sync the user started is already draining. A second
      // sync against the same engine would serialize behind the first anyway
      // and double the progress counter on the way, so it waits instead, and
      // many waiting requests collapse into one.
      if (syncFollowUp.current.request() === "queued") {
        followUpTrigger.current = trigger;
        return;
      }
      startSyncRef.current?.(trigger);
    },
    [node],
  );

  const startSync = useCallback((trigger: SyncTrigger) => {
    if (node.status !== "ready" || node.node.engine === null) {
      // Nothing to run against, so nothing is running and nothing waits.
      while (syncFollowUp.current.finished());
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    syncAbort.current?.abort();
    const abort = new AbortController();
    syncAbort.current = abort;
    void node.node
      .sync({
        trigger,
        signal: abort.signal,
        onRound: (result, rounds) => {
          // Per round, because the totals cannot answer the
          // question that matters here. `blocked` says something
          // this round *selected* could not be moved — a blob that
          // would not transfer — and it is deliberately kept out
          // of `outboundHasMore`, so a sync that ships rows and
          // moves no bytes looks identical in the totals to one
          // that had no bytes to move.
          console.warn(
            `[sync] trigger=${trigger} round=${rounds} applied=${result.applied} ` +
              `shipped=${result.shipped} elided=${result.elided} ` +
              `landed=${result.landed} uploaded=${result.uploaded} ` +
              `blocked=${result.blocked} hasMore=${result.hasMore} ` +
              `outboundHasMore=${result.outboundHasMore} ` +
              `bytesHasMore=${result.bytesHasMore} ` +
              `progressed=${result.progressed}`,
          );
        },
      })
      .then(async (result) => {
        // Every outcome, named. `sync()` has four exits and three
        // of them used to render identically to success: the round
        // cap, an abort, and a drained-but-incomplete return all
        // set `complete: false` with `stalled: false`, and the
        // chain below tested none of that. On a first library sync
        // — where one 10 MB round carries one camera original, so
        // sixty photographs need dozens of rounds — the abort is
        // not the rare case. It fires every time the app loses
        // focus, which is what checking whether the photos arrived
        // does. The one state indistinguishable from success was
        // the one that happened most.
        console.warn(
          `[sync] rounds=${result?.rounds} applied=${result?.applied} ` +
            `shipped=${result?.shipped} elided=${result?.elided} ` +
            `complete=${result?.complete} stalled=${result?.stalled} ` +
            `aborted=${abort.signal.aborted}`,
        );
        // A stalled sync is not an error and not a success: the
        // loop stopped because a round achieved nothing while work
        // was still outstanding, which in practice is a transfer
        // that will not go through. Saying nothing would show the
        // same quiet "Sync now" as a completed sync.
        // Ordered most specific first, so a diagnosis always beats
        // the generic "did not finish". An abort leads because it
        // is the only outcome the user caused and the only one
        // whose remedy is simply tapping again.
        setSyncError(
          abort.signal.aborted
            ? "Sync paused while the app was in the background. It carries on from where it stopped when you come back."
            : result?.stalled
              ? "Sync stopped making progress — something could not transfer. It will retry."
              : result?.refusedAuthors?.length
                ? "Some of this device's records are not reaching the cloud. Sync again to retry."
                : result?.peerCoverageDegraded
                  ? `The cloud could not report what it holds (${result.peerCoverageDegraded}), so this sync was conservative.`
                  : result && !result.complete
                    ? "Sync stopped before it finished. Tap Sync now to carry on."
                    : null,
        );
        await library.reload();
        storage.refresh();
      })
      .catch((err: unknown) => setSyncError(String(err)))
      .finally(() => {
        syncingRef.current = false;
        setSyncing(false);
        // A sync asked for while this one ran. Not after the app has left the
        // foreground: the waiting request was for an open app, and the
        // background windows have their own sync.
        if (syncFollowUp.current.finished()) {
          if (appActive.current) startSyncRef.current?.(followUpTrigger.current);
          else syncFollowUp.current.finished();
        }
      });
  }, [node, library, storage]);

  useEffect(() => {
    startSyncRef.current = startSync;
  }, [startSync]);

  /**
   * A sync nobody tapped for: a timer tick, a photograph just taken. Kept to
   * the catch-up's rule — never over a metered connection — because the sync
   * moves originals as well as rows. See `mayAutoSync`.
   */
  const autoSync = useCallback(
    async (trigger: SyncTrigger) => {
      const conditions = await readRealDeviceState().catch(() => null);
      const allowed = mayAutoSync({
        nodeReady: node.status === "ready",
        hasCloud: node.status === "ready" && node.node.engine !== null,
        device: conditions,
      });
      if (allowed) runSync(trigger);
    },
    [node, runSync],
  );

  /**
   * The camera roll changed while the app is open: import what is new, ship
   * its rows, make its sizes, and ship those. Waits for a running catch-up
   * rather than racing its import, by asking again a moment later.
   */
  const mediaChangeRetry = useRef<(() => void) | null>(null);
  const onMediaChange = useCallback(async () => {
    if (node.status !== "ready") return;
    if (catchingUpRef.current) {
      mediaChangeRetry.current?.();
      return;
    }
    catchingUpRef.current = true;
    try {
      const permission = await deviceMedia.getPermissions().catch(() => null);
      if (!permission?.granted) return;
      await library.importQuietly();
      await autoSync("media-change");
      await library.deriveRenditions();
      await autoSync("after-derive");
    } finally {
      catchingUpRef.current = false;
    }
  }, [node, library, autoSync]);

  /**
   * Bring the library up to date because somebody opened the app.
   *
   * Opening the app is the strongest signal this app ever gets that a person
   * wants their library current, and it used to be ignored: a photograph taken
   * thirty seconds ago entered the node when somebody tapped "Add photos", or
   * when a background window fired up to fifteen minutes later.
   *
   * The decisions are `planCatchUp`'s and none of them are made here — which is
   * what lets every branch of them be tested in Node. This performs the plan.
   *
   * `force` skips the interval guard, for a person pulling to refresh. The
   * other guards stay: a pull still waits for Wi-Fi before it uploads.
   */
  const runCatchUp = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    // Two `active` transitions can arrive while the first pass is still
    // importing, and the interval guard below cannot see a pass that has not
    // finished yet.
    if (catchingUpRef.current) return;
    catchingUpRef.current = true;
    try {
      // Read per pass rather than once on mount: a phone that was on cellular
      // when the app opened and is on Wi-Fi now must be allowed to upload now.
      const conditions = await readRealDeviceState().catch(() => null);
      const permission = await deviceMedia.getPermissions().catch(() => null);

      const plan = planCatchUp({
        nodeReady: node.status === "ready",
        syncing: syncingRef.current,
        mediaPermissionGranted: permission?.granted ?? false,
        hasCloud: node.status === "ready" && node.node.engine !== null,
        device: conditions,
        lastRunMs: force ? null : catchUpAt.current,
        nowMs: Date.now(),
      });
      if (!plan.import && !plan.sync) {
        // Nothing ran, so nothing is recorded and nothing is said. The interval
        // guard must not be armed by a pass that declined everything, or a node
        // that was not ready yet would suppress the pass that follows it.
        return;
      }

      if (plan.import) await library.importQuietly();

      // Rows first. A photograph this pass noticed ships now, rather than after
      // four backfills and a derivation pass, which on a real camera roll is
      // tens of seconds. The sizes derivation makes ship in a second sync,
      // below. `tick.ts` orders import before sync the same way.
      if (plan.sync) runSync(plan.import ? "after-import" : "open");

      // One batch of repair per app open, and only while there is repair left.
      // Gated on the import half's permission, because it reads the same media
      // store. See `backfillVideoDurations`.
      if (plan.import && !durationsBackfilled.current) {
        durationsBackfilled.current = await library.backfillDurations();
      }

      // The stills' half of the same repair, and the one that decides where a
      // tile sits: the grid is ordered by capture time, and a record with none
      // falls into the bucket at the end. Runs until it reports that it has
      // reached the end of the roll. See `backfillImageExif`.
      if (plan.import && !exifBackfilled.current) {
        exifBackfilled.current = await library.backfillExif();
      }

      // A video's posters and capture time, for the clips imported before this
      // device made them. Beside the EXIF repair, because the capture time
      // decides where the tile sits too. See `backfillVideoPosters`.
      if (plan.import && !postersBackfilled.current) {
        postersBackfilled.current = await library.backfillPosters();
      }

      // The placeholder every tile falls back to, for the records this device
      // imported before it could make one. Last of the three, and deliberately:
      // the two above decide where a tile *sits*, which changes what somebody is
      // looking at, and this decides what an unresolved tile paints — an
      // improvement to a grid that is already in the right order.
      //
      // Unlike those two it does not finish in one open, and does not need to.
      // See `MAX_THUMB_HASH_BACKFILL_PASSES`.
      if (plan.import && !thumbHashesBackfilled.current) {
        thumbHashesBackfilled.current = await library.backfillThumbHashes();
      }

      // The rungs this device's own camera roll needs, which is what makes its
      // grid legible without another node's help. Last of the four, and for the
      // reason the ThumbHash pass gives about the two above it: this improves
      // what a tile paints, and where a tile *sits* is the worse thing to have
      // wrong.
      //
      // Run here and not only in the background window, because the window
      // cannot carry it. Ninety seconds, shared with import and sync, six or
      // seven times a day, is a handful of records — against a camera roll with
      // thousands. See `DERIVE_RECORDS_PER_OPEN`.
      if (plan.import && !renditionsDerived.current) {
        renditionsDerived.current = await library.deriveRenditions();
      }

      // The assets the import watermark can never reach. Run on every catch-up
      // rather than once per launch, because the pass costs ten media-store
      // probes and a screenshot taken while the app is open would otherwise wait
      // for a relaunch to be noticed. The catch-up's own interval guard is what
      // bounds how often that happens. See `importNullModified`.
      if (plan.import) await library.sweepNullModified();

      // Again, for the rungs derivation just made. If the first sync is still
      // running this one waits behind it and runs when it ends.
      if (plan.sync && plan.import) runSync("after-derive");

      catchUpAt.current = Date.now();
    } finally {
      catchingUpRef.current = false;
    }
  }, [node, library, runSync]);

  /**
   * The latest {@link runCatchUp}, reachable from the subscription below.
   *
   * A ref rather than a dependency, because the effect's cleanup aborts the
   * running sync: re-subscribing whenever the callback's identity changed would
   * abort the very sync this is meant to keep alive, on every render.
   */
  const runCatchUpRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    runCatchUpRef.current = () => void runCatchUp();
  }, [runCatchUp]);

  /** The latest {@link autoSync} and {@link onMediaChange}, for the same reason. */
  const autoSyncRef = useRef<((trigger: SyncTrigger) => Promise<void>) | null>(null);
  const onMediaChangeRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    autoSyncRef.current = autoSync;
    onMediaChangeRef.current = onMediaChange;
  }, [autoSync, onMediaChange]);

  useEffect(() => {
    // While the app is open: a sync every thirty seconds, and an import and a
    // sync a few seconds after the camera roll changes. Both stop the moment
    // the app leaves the foreground; background windows are their own thing.
    const loop = createForegroundSyncLoop({ onTick: () => autoSyncRef.current?.("timer") });
    const mediaChange = createDebouncer(() => void onMediaChangeRef.current?.());
    mediaChangeRetry.current = () => mediaChange.trigger();
    let mediaSubscription: { remove(): void } | null = null;

    const enterForeground = (): void => {
      appActive.current = true;
      loop.start();
      mediaSubscription ??= deviceMedia.onChange?.(() => mediaChange.trigger()) ?? null;
    };
    const leaveForeground = (): void => {
      appActive.current = false;
      loop.stop();
      mediaChange.cancel();
      mediaSubscription?.remove();
      mediaSubscription = null;
      // A sync waiting behind the running one was asked for by an open app.
      syncFollowUp.current.cancel();
      // Stopping is cheap — every round has persisted its watermarks — and it
      // is what keeps an unbounded drain from running into the moment the OS
      // freezes the process. Nothing is armed for the way back: coming to the
      // foreground starts a pass unconditionally, and that pass syncs.
      syncAbort.current?.abort();
    };

    if (AppState.currentState === "active") enterForeground();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        leaveForeground();
        return;
      }
      enterForeground();
      runCatchUpRef.current?.();
    });
    return () => {
      subscription.remove();
      leaveForeground();
    };
  }, []);

  /**
   * The first pass, run when the node opens rather than when the screen mounts.
   *
   * Mounting is too early: the node takes seconds to open — 2.8 s on a Pixel 5
   * — and a pass that finds `nodeReady` false plans nothing and records
   * nothing. Keyed on readiness, the first pass happens on the launch that
   * needs it most, which is the one where nobody backgrounds the app at all.
   */
  const nodeReady = node.status === "ready";
  const [mediaAccess, setMediaAccess] = useState<MediaAccess | null>(null);
  /** Whether this launch has shown the system dialog, so it shows at most once. */
  const askedForMedia = useRef(false);
  /** Whether this launch has asked for the location half, so it asks at most once. */
  const askedForLocation = useRef(false);
  const readMediaAccess = useCallback(async () => {
    const permission = await deviceMedia.getPermissions().catch(() => null);
    if (permission) setMediaAccess(describeAccess(permission));
    return permission;
  }, []);

  /**
   * The photo permission, asked for on the first open.
   *
   * The library is the camera roll, so the first thing this app needs from a
   * person is access to it, and a photo app that opens on an empty grid and
   * waits to be told to look has asked for nothing and explained nothing.
   * Asked once per launch at most; a refusal leaves the grid's own prompt,
   * which asks again only when tapped.
   */
  useEffect(() => {
    if (!nodeReady) return;
    void (async () => {
      const permission = await readMediaAccess();
      const access = permission ? describeAccess(permission) : null;
      let granted = permission?.granted === true;
      if (nextAccessStep(access, "open", askedForMedia.current) === "ask") {
        askedForMedia.current = true;
        const answered = await deviceMedia.requestPermissions().catch(() => null);
        if (answered) setMediaAccess(describeAccess(answered));
        granted = answered?.granted === true;
      }
      // The location half of the photos permission, which a phone that granted
      // media access before this app declared it has never been asked for.
      // Without it every import loses its GPS. See `media/original-uri.ts`.
      if (
        shouldAskForMediaLocation({
          mediaGranted: granted,
          locationGranted: mediaLocationGranted(),
          askedThisLaunch: askedForLocation.current,
        })
      ) {
        askedForLocation.current = true;
        await deviceMedia.requestPermissions().catch(() => null);
        console.log(
          `[import] media-location permission ${mediaLocationGranted() ? "granted" : "still not granted"}`,
        );
      }
      runCatchUpRef.current?.();
    })();
  }, [nodeReady, readMediaAccess]);

  // A person who granted access in the system settings comes back through the
  // foreground, and the grid's prompt should go when they do.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void readMediaAccess();
    });
    return () => subscription.remove();
  }, [readMediaAccess]);

  const requestMediaAccess = useCallback(async () => {
    if (nextAccessStep(mediaAccess, "prompt", askedForMedia.current) === "open-settings") {
      await Linking.openSettings();
      return;
    }
    const answered = await deviceMedia.requestPermissions().catch(() => null);
    if (!answered) return;
    setMediaAccess(describeAccess(answered));
    if (answered.granted) runCatchUpRef.current?.();
  }, [mediaAccess]);

  /**
   * Ask the OS for the background window once per launch. Registering again is
   * harmless, and a launch that skipped it would leave a reinstalled app with no
   * window at all until something else asked.
   */
  useEffect(() => {
    void registerBackgroundWork().catch((err: unknown) =>
      console.warn(`[background] registration failed: ${String(err)}`),
    );
  }, []);

  const syncNow = useCallback(() => runSync("button"), [runSync]);
  const catchUpNow = useCallback(() => runCatchUp({ force: true }), [runCatchUp]);

  return { syncing, syncError, syncNow, catchUpNow, mediaAccess, requestMediaAccess };
}
