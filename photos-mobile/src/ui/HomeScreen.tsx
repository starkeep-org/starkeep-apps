/**
 * The app. Not a screen you reach by signing in — the one you land on.
 *
 * Everything here works with no session and no network: the node's checks are
 * local by construction, and the cloud probe is a single row that is allowed to
 * fail. Which is why that row shows a muted `—` rather than a red `FAIL`: on a
 * phone in a lift, the cloud being unreachable is the app working correctly,
 * and colouring it as a fault trains someone to ignore the two rows next to it
 * that genuinely are pass-or-fail.
 *
 * Connecting is offered here rather than demanded up front, because signing in
 * buys sync and nothing else. A device with no session is a whole Starkeep
 * node; it is simply the only one that knows what it holds.
 *
 * ## The order of the sections is the argument
 *
 * The device's own media is first, because it is the content and it depends on
 * nothing: no account, no cloud, no network, just an OS permission the user
 * grants directly. Sync comes after it, as an offer. The diagnostics come last,
 * because they are information about the machinery rather than the point of it.
 *
 * ## Why the last section states how the app behaves
 *
 * Because a person cannot otherwise tell a library that has nothing in it from
 * one that has not looked. The section is worth its place only while every
 * sentence in it is true: it used to say that nothing had synced and that a
 * handset could not hold the secret the data plane required, months after a
 * background tick had imported a photograph, uploaded it to S3 and pulled it to
 * a laptop in 9.2 seconds. Copy that describes a limitation the app no longer
 * has teaches a reader to distrust the rest of the screen, which is the same
 * argument `Check.required` makes about colouring the cloud probe red.
 *
 * The one limitation that stays is the true one: this device derives no
 * renditions, because there is no encoder on it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
// Glide-backed, like both grids. Imported here only for `clearMemoryCache`, so
// the screen can drop the decoded bitmaps when the app leaves the foreground.
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ActiveSession } from "../auth/session-manager";
import type { CloudConfig } from "../config";
import {
  DATABASE_PATH,
  OBJECTS_PATH,
  createLocalObjectStorage,
  deviceMedia,
  opSqliteDriver,
} from "../platform";
import { JOB_GRAPH, runnableJobs, type DeviceState } from "../work/job-graph";
import { planCatchUp, type CatchUpPlan } from "../work/foreground-catchup";
import {
  backgroundWorkStatus,
  readRealDeviceState,
  registerBackgroundWork,
  tickReportStore,
} from "../work/background-task";
import type { TickReport } from "../work/tick";
import type { ImportOutcome } from "../media/import";
import { formatBytes } from "./format";
import {
  libraryRowKey,
  libraryRows,
  LibraryRow,
  useLibraryViewer,
} from "./LibraryGrid";
import type { JustifiedRow } from "../photos/render-target";
import type { LibraryItem } from "../library";
import { MediaGrid } from "./MediaGrid";
import { styles } from "./theme";
import { useLibrary, useNode, useStorage } from "./use-library";
import type { EvictionOutcome } from "@starkeep/sync-engine";
import { describeVerify, verifyFoundProblem } from "./verify-text";
import type { VerifyResult } from "@starkeep/sync-engine";

/** The device's conditions, as one line under the job count. */
function describeDevice(device: DeviceState): string {
  return [
    device.hasNetwork ? (device.isUnmetered ? "unmetered network" : "metered network") : "offline",
    device.isCharging ? "charging" : "on battery",
    device.batteryLevel === undefined
      ? "battery unknown"
      : `battery ${Math.round(device.batteryLevel * 100)}%`,
    device.isLowPowerMode ? "power saver on" : "power saver off",
    device.isStorageLow ? "storage low" : "storage fine",
  ].join(" · ");
}

interface Check {
  readonly name: string;
  readonly detail: string;
  readonly ok: boolean;
  /**
   * Whether failing means something is wrong.
   *
   * The cloud probe is not required: a phone with no signal is not a broken
   * phone, and marking that row `FAIL` in red would train someone to ignore the
   * two rows next to it that genuinely are pass-or-fail.
   */
  readonly required?: boolean;
}

interface Props {
  /** Null when this device has never signed in — which is a supported way to run. */
  readonly session: ActiveSession | null;
  /** False only for the instant before the session file has been read. */
  readonly sessionKnown: boolean;
  /** Null on a build with no cloud configured — the node still runs. */
  readonly config: CloudConfig | null;
  readonly canRefreshSession: boolean;
  readonly onRefreshSession: () => Promise<void>;
  /** Null when there is no pool to connect to, which hides the offer entirely. */
  readonly onConnect: (() => void) | null;
  readonly onSignOut: () => void;
}

/**
 * Does the database open and does object storage do a ranged read.
 *
 * These two were the dev shell's whole reason to exist and they stay, because
 * they are still the only answers a laptop cannot give: `executeSync` on real
 * op-sqlite and `FileHandle.offset` on a real filesystem are exactly the
 * behaviours the Node fakes had to assume.
 */
async function runNodeChecks(): Promise<Check[]> {
  const results: Check[] = [];

  try {
    const db = opSqliteDriver.open(DATABASE_PATH);
    db.exec("CREATE TABLE IF NOT EXISTS shell_probe (k TEXT PRIMARY KEY, v INTEGER)");
    db.prepare("INSERT OR REPLACE INTO shell_probe VALUES (?, ?)").run("boot", Date.now());
    const row = db.prepare("SELECT v FROM shell_probe WHERE k = ?").get("boot") as
      | { v: number }
      | undefined;
    opSqliteDriver.close(db);
    results.push({
      name: "SQLite (op-sqlite)",
      detail: row ? `wrote and read back ${new Date(row.v).toISOString()}` : "no row returned",
      ok: Boolean(row),
    });
  } catch (err) {
    results.push({ name: "SQLite (op-sqlite)", detail: String(err), ok: false });
  }

  try {
    const storage = createLocalObjectStorage();
    await storage.init();
    const key = "0".repeat(64);
    const payload = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
    await storage.put(key, payload);
    const stream = await storage.getStream(key, { start: 8, end: 11 });
    const reader = stream!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const got = Array.from(value ?? []);
    results.push({
      name: "Object storage (expo-file-system)",
      detail: `ranged read gave [${got.join(", ")}] — expected [8, 9, 10, 11]`,
      ok: got.join(",") === "8,9,10,11",
    });
  } catch (err) {
    results.push({ name: "Object storage (expo-file-system)", detail: String(err), ok: false });
  }

  return results;
}

/**
 * The cloud's unauthenticated health route.
 *
 * Unauthenticated deliberately, and labelled as such on screen: it proves the
 * handset has a route to the gateway, which is the failure this app is most
 * likely to hit first, and it proves nothing about authorisation.
 */
async function checkCloud(baseUrl: string): Promise<Check> {
  const url = `${baseUrl.replace(/\/+$/, "")}/health`;
  try {
    const response = await fetch(url);
    const text = (await response.text()).slice(0, 120);
    return {
      name: "Cloud",
      detail: `GET /health → ${response.status} ${text}`,
      ok: response.ok,
      required: false,
    };
  } catch (err) {
    return { name: "Cloud", detail: String(err), ok: false, required: false };
  }
}

export function HomeScreen({
  session,
  sessionKnown,
  config,
  canRefreshSession,
  onRefreshSession,
  onConnect,
  onSignOut,
}: Props) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The hook rather than `Dimensions.get`, because this value has to re-render
  // the screen: the justified rows are laid out against it, and a rotation that
  // did not re-flow them would leave every row measured for the other width.
  const window = useWindowDimensions();
  const { state: node, reset } = useNode();
  const library = useLibrary(node);
  const storage = useStorage(node);
  /**
   * Whether the reset button is armed.
   *
   * Two taps rather than one, because this is destructive and irreversible.
   * Not a modal: a confirm dialog for a developer affordance is heavier than
   * the action deserves, and an inline label that changes to say exactly what
   * is about to happen is more informative than a generic "Are you sure?".
   */
  const [confirmingReset, setConfirmingReset] = useState(false);
  /**
   * Whether the camera-roll grid has been asked for.
   *
   * Not persisted across launches, deliberately: a diagnostic panel that stays
   * open because somebody opened it once last week is a panel nobody meant to
   * open, and this one costs a media-store scan every time it mounts.
   */
  const [showDeviceMedia, setShowDeviceMedia] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  /**
   * Rounds completed and items moved so far in the running sync.
   *
   * Worth showing rather than a bare spinner: a round is deliberately small
   * (see MOBILE_MAX_BYTES), so a first upload is hundreds of them and a user
   * otherwise has no way to tell a working sync from a wedged one.
   */
  const [syncProgress, setSyncProgress] = useState<{ rounds: number; items: number } | null>(
    null,
  );
  /**
   * Result of the last integrity check.
   *
   * Worth its own control rather than folding into "Sync now": it is a grouped
   * scan on both sides, and it answers a different question. A watermark says
   * "caught up"; this says how many rows are actually on the other end, which
   * is the only form of "your library is backed up" that is a statement of fact
   * rather than of belief.
   */
  const [verifyState, setVerifyState] = useState<
    { checking: true } | { checking: false; result: VerifyResult | null } | null
  >(null);
  const [resetting, setResetting] = useState(false);
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
   * What the last foreground catch-up did, for the line under the Sync section.
   *
   * A pass that declined a half has to say so. "Waiting for Wi-Fi before
   * uploading" is the common case, and silence there reads as a feature that
   * does not work rather than as one that is waiting for a condition.
   */
  const [lastCatchUp, setLastCatchUp] = useState<{
    readonly plan: CatchUpPlan;
    readonly imported: ImportOutcome | null;
  } | null>(null);
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
  /** Same, for the placeholder every record paints before its bytes resolve. */
  const thumbHashesBackfilled = useRef(false);

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
  const runSync = useCallback(() => {
    if (node.status !== "ready" || node.node.engine === null) return;
    // A catch-up and a tap can race — the app comes back to the foreground
    // while a sync the user started is already draining. Starting a second one
    // against the same engine would serialize behind the first anyway and
    // double the progress counter on the way.
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncProgress(null);
    syncAbort.current?.abort();
    const abort = new AbortController();
    syncAbort.current = abort;
    let items = 0;
    void node.node
      .sync({
        signal: abort.signal,
        onRound: (result, rounds) => {
          items += result.applied + result.shipped;
          setSyncProgress({ rounds, items });
          // Per round, because the totals cannot answer the
          // question that matters here. `blocked` says something
          // this round *selected* could not be moved — a blob that
          // would not transfer — and it is deliberately kept out
          // of `outboundHasMore`, so a sync that ships rows and
          // moves no bytes looks identical in the totals to one
          // that had no bytes to move.
          console.warn(
            `[sync] round=${rounds} applied=${result.applied} ` +
              `shipped=${result.shipped} elided=${result.elided} ` +
              `blocked=${result.blocked} hasMore=${result.hasMore} ` +
              `outboundHasMore=${result.outboundHasMore} ` +
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
                ? "Some of this device's records are not reaching the cloud. Check backup to try again."
                : result?.peerCoverageDegraded
                  ? `The cloud could not report what it holds (${result.peerCoverageDegraded}), so this sync was conservative.`
                  : result && !result.complete
                    ? "Sync stopped before it finished. Tap Sync now to carry on."
                    : null,
        );
        await library.reload();
        // Sync is the event that fills the disk, so it is the
        // event that should notice the disk is full. Without a
        // caller here, a budget bounds new arrivals and nothing
        // bounds what is already held: `decideResidency` starts
        // answering `budget-exhausted`, the node quietly stops
        // fetching that class, and stays full forever.
        //
        // After the reload rather than before, so the grid is
        // already showing what arrived when the pass starts
        // deciding what to let go.
        await storage.reclaim();
      })
      .catch((err: unknown) => setSyncError(String(err)))
      .finally(() => {
        syncingRef.current = false;
        setSyncing(false);
      });
  }, [node, library, storage]);

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
   */
  const runCatchUp = useCallback(async () => {
    // Two `active` transitions can arrive while the first pass is still
    // importing, and the interval guard below cannot see a pass that has not
    // finished yet.
    if (catchingUpRef.current) return;
    catchingUpRef.current = true;
    try {
      // Read here rather than reused from the Work section's copy, which is
      // fetched once on mount: a phone that was on cellular when the app opened
      // and is on Wi-Fi now must be allowed to upload now.
      const conditions = await readRealDeviceState().catch(() => null);
      const permission = await deviceMedia.getPermissions().catch(() => null);

      const plan = planCatchUp({
        nodeReady: node.status === "ready",
        syncing: syncingRef.current,
        mediaPermissionGranted: permission?.granted ?? false,
        hasCloud: node.status === "ready" && node.node.engine !== null,
        device: conditions,
        lastRunMs: catchUpAt.current,
        nowMs: Date.now(),
      });
      if (!plan.import && !plan.sync) {
        // Nothing ran, so nothing is recorded and nothing is said. The interval
        // guard must not be armed by a pass that declined everything, or a node
        // that was not ready yet would suppress the pass that follows it.
        return;
      }

      const imported = plan.import ? await library.importQuietly() : null;

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

      // The assets the import watermark can never reach. Run on every catch-up
      // rather than once per launch, because the pass costs ten media-store
      // probes and a screenshot taken while the app is open would otherwise wait
      // for a relaunch to be noticed. The catch-up's own interval guard is what
      // bounds how often that happens. See `importNullModified`.
      if (plan.import) await library.sweepNullModified();

      // After the import resolves, so a photograph this pass noticed ships in
      // this pass. `tick.ts` orders the same two jobs the same way.
      if (plan.sync) runSync();

      catchUpAt.current = Date.now();
      setLastCatchUp({ plan, imported });
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

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        // Stopping is cheap — every round has persisted its watermarks — and it
        // is what keeps an unbounded drain from running into the moment the OS
        // freezes the process. Nothing is armed for the way back: coming to the
        // foreground starts a pass unconditionally, and that pass syncs.
        syncAbort.current?.abort();
        return;
      }
      runCatchUpRef.current?.();
    });
    return () => {
      subscription.remove();
      syncAbort.current?.abort();
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
  useEffect(() => {
    if (!nodeReady) return;
    runCatchUpRef.current?.();
  }, [nodeReady]);

  /**
   * What the last background tick did, whether the OS will run another, and
   * what this device's conditions actually are.
   *
   * Read once on mount rather than polled: a tick cannot run while this screen
   * is in the foreground — the Android scheduler refuses and reschedules — so
   * the report file cannot change under an open screen.
   *
   * The device reading comes from the same function the tick uses. Two readers
   * with two sources is how a debug panel comes to disagree with the scheduler
   * it exists to explain.
   */
  const [tickReport, setTickReport] = useState<TickReport | null>(null);
  const [backgroundStatus, setBackgroundStatus] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await registerBackgroundWork();
        const status = await backgroundWorkStatus();
        if (!cancelled) setBackgroundStatus(status);
      } catch (err) {
        if (!cancelled) setBackgroundStatus(String(err));
      }
      const [report, conditions] = await Promise.all([
        tickReportStore.read(),
        readRealDeviceState(),
      ]);
      if (cancelled) return;
      setTickReport(report);
      setDevice(conditions);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const baseUrl = config?.baseUrl;

  const collect = useCallback(async (): Promise<Check[]> => {
    // The node first, and never behind the cloud probe: `Promise.all` rather
    // than a sequence means a request hanging on a dead network cannot delay
    // the two answers that came off this device.
    const [node, cloud] = await Promise.all([
      runNodeChecks(),
      baseUrl
        ? checkCloud(baseUrl)
        : Promise.resolve({
            name: "Cloud",
            detail: "no cloud data server in this build's config",
            ok: false,
            required: false,
          }),
    ]);
    return [...node, cloud];
  }, [baseUrl]);

  useEffect(() => {
    let cancelled = false;
    void collect().then((results) => {
      if (!cancelled) setChecks(results);
    });
    return () => {
      cancelled = true;
    };
  }, [collect]);

  /**
   * The viewer, owned here rather than by the grid.
   *
   * A row is mounted and unmounted as it scrolls; the viewer has to outlive
   * every one of them, because it is opened from a tile and must survive that
   * tile being recycled while somebody is looking at the picture. See
   * `useLibraryViewer`.
   */
  const viewer = useLibraryViewer({
    onFetch: library.fetchBlob,
    onFetchRendition: library.fetchRendition,
    onOpenForViewer: library.openForViewer,
    onSetPinned: library.setPinned,
    isPinned: library.isPinned,
    onOpened: library.noteOpened,
    onOpenMotion: library.openMotion,
    onClosed: library.reclaimAfterViewing,
  });

  /**
   * Whether the node already holds a device asset, for the device grid's marks.
   *
   * Reads the alias table directly, which is the same question `alreadyImported`
   * asks during an import — so a tile marked absent here is one the next import
   * pass would consider. On a node that reads no camera roll there is no table,
   * and the grid is told nothing rather than told "missing": marking every tile
   * absent because nobody could answer would be worse than marking none.
   */
  const aliases = node.status === "ready" ? node.node.mediaAliases : null;
  const isImported = useCallback(
    (assetId: string) => aliases?.byAssetId(assetId) != null,
    [aliases],
  );

  // Laid out against the window's current width, so a rotation re-flows the rows
  // rather than leaving them measured for the old one. `useWindowDimensions`
  // re-renders on the change, which is what makes the memo re-run.
  const rows = useMemo(
    () => libraryRows(library.items, window.width),
    [library.items, window.width],
  );

  const openItem = viewer.open;
  const renderRow = useCallback(
    ({ item }: { item: JustifiedRow<LibraryItem> }) => <LibraryRow row={item} onOpen={openItem} />,
    [openItem],
  );

  /**
   * Drop the decoded bitmaps when the app leaves the foreground.
   *
   * `expo-image` keeps Glide's memory cache alive across an unmount, which is
   * what makes scrolling back up instant and is also what a process about to be
   * frozen is holding when Android decides which app to kill. The viewer's own
   * picture is the only thing worth keeping resident, and it is one picture.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void Image.clearMemoryCache();
    });
    return () => subscription.remove();
  }, []);

  /**
   * Everything above the grid.
   *
   * An element rather than a component, deliberately: `FlatList` remounts a
   * `ListHeaderComponent` passed as a function type on every render, which
   * would tear down and rebuild the header — and anything holding state inside
   * it — on every scroll frame. An element is reconciled like any other child.
   */
  const header = (
    <View style={{ gap: 20, marginBottom: 20 }}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>Starkeep Photos</Text>
        <Text style={styles.subtitle}>{sessionLabel(session, sessionKnown)}</Text>
      </View>
      <Text style={styles.sectionTitle}>This node&rsquo;s library</Text>
      {library.error ? <Text style={styles.error}>{library.error}</Text> : null}
    </View>
  );

  /** What the grid says when the node holds nothing. */
  const empty = (
    <Text style={styles.muted}>
      {library.loading
        ? "Reading this node's library…"
        : "Nothing has been added to this node yet. The photos on this device are still just on this device."}
    </Text>
  );

  /** Everything below the grid, header's argument applying equally. */
  const footer = (
    <View style={{ gap: 20, marginTop: 20 }}>
      <View style={{ gap: 8 }}>
        {library.loadingMore ? (
          <Text style={styles.muted}>Loading more…</Text>
        ) : (
          <Text style={styles.muted}>
            {library.summary
              ? library.items.length < library.summary.records
                ? `${library.items.length} of ${library.summary.records} records shown.`
                : `${library.summary.records} ${library.summary.records === 1 ? "record" : "records"} in this node's library. Tap one to open it.`
              : `${library.items.length} shown.`}
          </Text>
        )}
        {/* **A control, not just a scroll trigger.** Everything below the grid
            rides in this list's footer, so the end of the tiles is several
            screens above the end of the content — which means `onEndReached`
            fires only once somebody has scrolled through the whole rest of the
            screen. Saying "keep scrolling" and then ending is exactly what that
            produces. The tap is the reliable route; the scroll trigger stays as
            the convenient one. */}
        {library.hasMore && !library.loadingMore ? (
          <Pressable onPress={() => void library.loadMore()} style={styles.button}>
            <Text style={styles.buttonLabel}>Show more photos</Text>
          </Pressable>
        ) : null}
        {library.loadMoreError ? (
          <Text style={styles.error}>{library.loadMoreError}</Text>
        ) : null}
          {node.status === "ready" ? (
            <Pressable
              onPress={() => void library.importNow()}
              disabled={library.importing}
              style={[styles.button, library.importing ? styles.buttonDisabled : null]}
            >
              <Text style={styles.buttonLabel}>
                {library.importing
                  ? library.progress
                    ? `Adding ${library.progress.done} of ${library.progress.total}…`
                    : "Adding…"
                  : "Add photos from this device"}
              </Text>
            </Pressable>
          ) : null}
          {library.lastImport ? (
            <>
              <Text style={styles.muted}>{describeImport(library.lastImport)}</Text>
              {/* The reason, not just the count. A screen that can only say
                  "60 could not be read" cannot be acted on, and that is exactly
                  what the first version of this said when every asset failed. */}
              {library.lastImport.failures.length > 0 ? (
                <Text style={styles.error}>{library.lastImport.failures[0]!.reason}</Text>
              ) : null}
            </>
          ) : null}
          {library.summary && library.summary.records > 0 ? (
            <Text style={styles.muted}>
              {formatBytes(library.summary.aliasedBytes)} of it is held by this device&rsquo;s media
              store rather than copied — Starkeep points at your photos instead of duplicating them.
            </Text>
          ) : null}

          {node.status === "ready" ? (
            <View style={{ gap: 6, marginTop: 4 }}>
              <Pressable
                onPress={() => {
                  if (!confirmingReset) {
                    setConfirmingReset(true);
                    return;
                  }
                  setConfirmingReset(false);
                  setResetting(true);
                  void reset()
                    .then(() => library.reload())
                    .finally(() => setResetting(false));
                }}
                disabled={resetting}
                style={{ paddingVertical: 8 }}
              >
                <Text style={confirmingReset ? styles.error : styles.linkLabel}>
                  {resetting
                    ? "Clearing…"
                    : confirmingReset
                      ? "Tap again to clear this node"
                      : "Clear this node's data"}
                </Text>
              </Pressable>
              {confirmingReset ? (
                // Says what is destroyed *and* what is not. The distinction is
                // the whole reason this is safe: the originals were never
                // copied here, so there is nothing to lose but the index.
                <Text style={styles.muted}>
                  Deletes {library.summary?.records ?? 0} record
                  {library.summary?.records === 1 ? "" : "s"} and everything in this node&rsquo;s
                  object store. Your photos are not touched — they live in the device&rsquo;s media
                  store and Starkeep only points at them.
                </Text>
              ) : null}
            </View>
          ) : null}
      </View>
      <Section title="Storage">
        {storage.report === null || !storage.report.configured ? (
          <Text style={styles.muted}>
            This node has no storage budget, so it keeps every byte it is offered. That is the
            right default for a laptop and the wrong one for a phone.
          </Text>
        ) : (
          <>
            <Text style={styles.body}>
              {formatBytes(storage.report.heldBytes)} held of{" "}
              {formatBytes(storage.report.budgetBytes)} allowed
            </Text>
            {storage.report.classes
              // Only rows that are doing something. A phone that has synced
              // nothing would otherwise show twelve zeroes, which says less
              // than one sentence does.
              .filter((c) => c.heldBytes > 0)
              .map((c) => (
                <View key={c.sizeClass} style={styles.row}>
                  <View style={styles.rowText}>
                    <Text style={styles.body}>{c.sizeClass}</Text>
                    <Text style={styles.muted}>
                      {formatBytes(c.heldBytes)} of {formatBytes(c.budgetBytes)} ·{" "}
                      {c.prefetch ? "synced" : "kept when opened"}
                    </Text>
                  </View>
                </View>
              ))}
            {storage.report.classes.every((c) => c.heldBytes === 0) ? (
              <Text style={styles.muted}>
                Nothing has been fetched from the cloud yet. Photos taken on this device are not
                counted here — Starkeep points at them in your camera roll rather than keeping a
                second copy, so they cost this budget nothing and cannot be reclaimed.
              </Text>
            ) : null}

            {/* The other half of a budget. Declining bytes bounds new
                arrivals; nothing bounds what is already here, so a node that
                fills up used to simply stop fetching and stay full. */}
            <Pressable
              onPress={() => void storage.reclaim()}
              disabled={storage.reclaiming}
              style={[styles.button, storage.reclaiming ? styles.buttonDisabled : null]}
            >
              <Text style={styles.buttonLabel}>
                {storage.reclaiming ? "Reclaiming…" : "Free up space"}
              </Text>
            </Pressable>
            {storage.lastPass ? (
              <Text style={styles.muted}>{describeReclaim(storage.lastPass)}</Text>
            ) : null}
            {storage.error ? <Text style={styles.error}>{storage.error}</Text> : null}
          </>
        )}
      </Section>

      <Section title="On this device">
        {/* **Closed until asked for, and the saving is real rather than
            cosmetic.** `MediaGrid` requests its permission and calls
            `listRecentMedia` from a mount effect, and that query runs
            `ExifInterface` and `MediaMetadataRetriever` per returned row
            inside the media store process — the cost `import-cursor.ts`
            measured at over nine minutes for twenty rows on a loaded Pixel 5.
            Not rendering it does not merely hide sixty tiles, it does not ask
            the question at all. */}
        {showDeviceMedia ? (
          <MediaGrid media={deviceMedia} {...(aliases ? { isImported } : {})} />
        ) : (
          <Pressable onPress={() => setShowDeviceMedia(true)} style={{ paddingVertical: 8 }}>
            <Text style={styles.linkLabel}>Show the photos on this device</Text>
          </Pressable>
        )}
        {/* Says what the section is for, which matters more now that opening
            it takes a deliberate act: this answers "what is on this phone",
            and the library above answers "what does this node hold". The two
            stop agreeing the moment anything syncs in or is imported and then
            deleted from the camera roll. */}
        <Text style={styles.muted}>
          The device&rsquo;s own camera roll, read straight from the media store. This node&rsquo;s
          library is the section at the top; the two are not the same set.
        </Text>
      </Section>

      <Section title="Status">
        {checks === null ? (
          <Text style={styles.muted}>Checking…</Text>
        ) : (
          checks.map((c) => (
            <View key={c.name} style={styles.row}>
              <Text
                style={[styles.badge, c.ok ? styles.ok : c.required === false ? styles.info : styles.bad]}
              >
                {c.ok ? "OK" : c.required === false ? "—" : "FAIL"}
              </Text>
              <View style={styles.rowText}>
                <Text style={styles.body}>{c.name}</Text>
                <Text style={styles.muted}>{c.detail}</Text>
              </View>
            </View>
          ))
        )}
        <Text style={styles.muted}>
          Pull down to run these again{canRefreshSession ? " and retry the session" : ""}.
        </Text>
      </Section>

      <Section title="This node">
        {node.status === "ready" ? (
          <Text style={styles.mono}>{node.identity.nodeId}</Text>
        ) : node.status === "failed" ? (
          // Named as a node failure rather than left to look like an empty
          // library: "you have no photos" and "the database would not open"
          // are the same screen otherwise, and only one of them is a bug.
          <Text style={styles.error}>This node did not open: {node.error}</Text>
        ) : (
          <Text style={styles.muted}>Opening…</Text>
        )}
        <Text style={styles.mono}>{DATABASE_PATH}</Text>
        <Text style={styles.mono}>{OBJECTS_PATH}</Text>
        <Text style={styles.muted}>
          {config ? `${config.userPoolId} · ${config.region}` : "no cloud configured in this build"}
        </Text>
      </Section>

      <Section title="Work">
        <Text style={styles.muted}>
          {JOB_GRAPH.length} jobs declared,{" "}
          {device ? `${runnableJobs(device).length} runnable right now` : "conditions loading…"}.
        </Text>
        {device ? <Text style={styles.muted}>{describeDevice(device)}</Text> : null}
        <Text style={styles.muted}>Background task: {backgroundStatus ?? "registering…"}</Text>
        {/* The last tick, read from the file it left behind. The process that
            produced it is gone, so this is the only place its report can
            appear — logcat needs a cable, and the whole question is what the
            phone does with nobody watching. */}
        {tickReport ? (
          <>
            <Text style={styles.muted}>
              Last background tick {tickReport.startedAt} ({tickReport.totalMs} ms
              {tickReport.ranOutOfTime ? ", out of time" : ""})
            </Text>
            {/* The whole point of the field is that a person sees it here. A
                window wedged on a call that never returns writes no report of
                its own, so this line is the only account of what it was doing
                when the watchdog gave up on it. */}
            {tickReport.abandoned ? (
              <Text style={styles.muted}>Abandoned while {tickReport.abandoned}</Text>
            ) : null}
            {tickReport.outcomes.map((outcome) => (
              <Text key={outcome.job} style={styles.muted}>
                {outcome.ran ? "ran" : "—"} {outcome.job}: {outcome.detail}
              </Text>
            ))}
          </>
        ) : (
          <Text style={styles.muted}>No background tick has reported yet.</Text>
        )}
      </Section>

      <Section title="Sync">
        {node.status === "ready" ? (
          <>
            <Pressable
              onPress={() => runSync()}
              disabled={syncing || node.node.engine === null}
              style={[
                styles.button,
                syncing || node.node.engine === null ? styles.buttonDisabled : null,
              ]}
            >
              <Text style={styles.buttonLabel}>{syncing ? "Syncing…" : "Sync now"}</Text>
            </Pressable>
            {syncing && syncProgress ? (
              <Text style={styles.muted}>
                {syncProgress.items} item{syncProgress.items === 1 ? "" : "s"} in{" "}
                {syncProgress.rounds} round{syncProgress.rounds === 1 ? "" : "s"}…
              </Text>
            ) : null}
            {node.node.engine === null ? (
              <Text style={styles.muted}>
                No cloud is configured in this build, so there is nothing to exchange with.
              </Text>
            ) : null}
            {syncError ? <Text style={styles.error}>{syncError}</Text> : null}
            {/* What happened without anybody asking. A catch-up that declined
                a half has to say which one: "waiting for Wi-Fi" is the common
                case, and silence there reads as a feature that does not work
                rather than as one that is waiting for a condition. */}
            {library.catchingUp ? (
              <Text style={styles.muted}>Checking for new photos…</Text>
            ) : lastCatchUp ? (
              <Text style={styles.muted}>{describeCatchUp(lastCatchUp)}</Text>
            ) : null}

            <Pressable
              onPress={() => {
                setVerifyState({ checking: true });
                void node.node
                  .verify()
                  .then((result) => setVerifyState({ checking: false, result }))
                  .catch((err: unknown) => {
                    setSyncError(String(err));
                    setVerifyState(null);
                  });
              }}
              disabled={syncing || verifyState?.checking === true || node.node.engine === null}
              style={[
                styles.button,
                syncing || verifyState?.checking === true || node.node.engine === null
                  ? styles.buttonDisabled
                  : null,
              ]}
            >
              <Text style={styles.buttonLabel}>
                {verifyState?.checking ? "Checking…" : "Check backup"}
              </Text>
            </Pressable>
            {verifyState && !verifyState.checking ? (
              <Text style={verifyFoundProblem(verifyState.result) ? styles.error : styles.muted}>
                {describeVerify(verifyState.result)}
              </Text>
            ) : null}

            {/* The pairing details. On screen because pairing is done from
                admin-web — a device cannot authenticate its own first
                registration, so the operator approves it from the privileged
                console. Until then every request is refused, which is the
                honest state and is what the error above will say. */}
            <Text style={styles.muted}>
              To let this device sync, pair it in admin-web with these values:
            </Text>
            <Text style={styles.mono} selectable>
              {node.deviceKey.deviceId}
            </Text>
            <Text style={styles.mono} selectable>
              {node.deviceKey.publicKeySpki}
            </Text>
          </>
        ) : null}

        {session ? (
          <>
            <Text style={styles.muted}>
              {session.tokens
                ? `Connected as ${session.email ?? "this account"}.`
                : `Signed in as ${session.email ?? "this account"}, using the session stored on this device. It will refresh itself when there is a connection.`}
            </Text>
            <Pressable onPress={onSignOut} style={{ paddingVertical: 8 }}>
              <Text style={styles.linkLabel}>Disconnect</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.muted}>
              This device is not connected to a cloud, so nothing leaves it and nothing arrives.
              Everything above is local and stays that way.
            </Text>
            {onConnect && sessionKnown ? (
              <Pressable onPress={onConnect} style={[styles.button, { marginTop: 4 }]}>
                <Text style={styles.buttonLabel}>Connect this device</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </Section>

      <Section title="How this works">
        <Text style={styles.muted}>
          Photos and videos on this device are added to the node when you open the app, and again
          in the background every so often. Sync sends them on once this device is paired.
        </Text>
        <Text style={styles.muted}>
          Automatic sync waits for Wi-Fi, because it uploads originals and doing that over
          cellular costs you money. Sync now overrides the wait.
        </Text>
        <Text style={styles.muted}>
          A Motion Photo plays its video when you open it, and stores nothing extra — the video
          was always inside the photograph.
        </Text>
        <Text style={styles.muted}>
          This device does not make smaller copies of your photos. Everything it shows is either
          the original or a smaller copy some other device made and sent here, so a photo taken
          on this phone is decoded at full size every time a tile draws it.
        </Text>
      </Section>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      {/* **A list, not a `ScrollView`, and the library's rows are its items.**
          The grid used to map every record into a wrapping `View` inside a
          scroll view, so nothing ever unmounted: every tile the grid had ever
          loaded stayed mounted with its bitmap decoded. At sixty tiles that was
          survivable and at five hundred it is not, which is why paging the
          library and virtualizing it are one change rather than two — a
          paginated grid that never releases a tile is worse than the ceiling it
          replaces.

          The rest of the screen rides along as the header and the footer, so
          there is still exactly one scroll on this screen and no list nested
          inside another — the arrangement `MediaGrid`'s own note warns about. */}
      <FlatList
        data={rows}
        keyExtractor={libraryRowKey}
        renderItem={renderRow}
        // **No `getItemLayout`.** A row's height is a closed form, so supplying
        // one was tempting — but `VirtualizedList` expects the offset it returns
        // to include the header's height, and the header here is a title, a
        // subtitle and a heading whose height nothing computes. Offsets short by
        // that amount put every item at the wrong place, which is what made the
        // list mis-measure its own end and stop asking for more. Measuring costs
        // a pass per row and is correct.
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={empty}
        // Generous, because the footer below the grid is several screens tall:
        // the end of the *content* is far below the end of the tiles, so a
        // tighter threshold would only ever fire once somebody had scrolled
        // through the whole of the rest of the screen.
        onEndReachedThreshold={2}
        onEndReached={() => void library.loadMore()}
        // Roughly two screens of tiles resident. Enough that a flick does not
        // outrun the renderer, few enough that the decoded bitmaps stay bounded
        // no matter how far the library is scrolled.
        windowSize={5}
        initialNumToRender={7}
        maxToRenderPerBatch={6}
        removeClippedSubviews
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor="#888"
            onRefresh={() => {
              setRefreshing(true);
              // Pull-to-refresh also retries the session, which is how an
              // offline session becomes live again without a force-quit.
              void Promise.all([
                collect().then(setChecks),
                library.reload(),
                canRefreshSession ? onRefreshSession() : Promise.resolve(),
              ]).finally(() => setRefreshing(false));
            }}
          />
        }
      />
      {/* Outside the list, because a full-screen modal inside a recycled row is
          a modal that closes when the row it was opened from scrolls away. */}
      {viewer.element}
    </SafeAreaView>
  );
}

/**
 * Who this device thinks it is.
 *
 * "Local node" rather than "not signed in": the absence of a session is a way
 * to run, not a thing missing, and a subtitle that reads as a deficiency is the
 * sign-in gate growing back as copy.
 *
 * An unrefreshed session *is* named as such, because that one is a true and
 * slightly unusual state — someone debugging a handset should be able to see
 * that its tokens are stale without inferring it from a failing cloud row.
 */
function sessionLabel(session: ActiveSession | null, sessionKnown: boolean): string {
  if (!sessionKnown) return "local node";
  if (!session) return "local node · not connected";
  const who = session.email ?? "connected";
  return session.tokens ? who : `${who} · offline session`;
}

/**
 * What one import pass did.
 *
 * `skipped` and `failed` are only mentioned when non-zero, because on the
 * common second run everything is skipped and "60 skipped" is the sentence
 * that explains why nothing appeared to happen. Silence there would read as
 * the button not working.
 */
/**
 * What one reclaim pass did, in a sentence.
 *
 * The **refusals matter more than the deletions** here, which is why they come
 * first and are stated as a reason rather than a count. A pass that freed
 * nothing because there is no cloud to confirm anything survives elsewhere is
 * working exactly as designed — this is the only code in the app that destroys a
 * user's data, and "the budget is full" is not evidence that a photograph is
 * safe somewhere. Reporting that as "0 removed" would read as a broken button
 * and invite someone to make it try harder.
 */
function describeReclaim(outcomes: readonly EvictionOutcome[]): string {
  const refusal = outcomes.find((o) => o.refusal !== null)?.refusal;
  if (refusal) return refusal;

  const freed = outcomes.reduce(
    (n, o) => n + o.evicted.reduce((b, e) => b + e.sizeBytes, 0),
    0,
  );
  const kept = outcomes.reduce((n, o) => n + o.kept.length, 0);
  const corrupt = outcomes.flatMap((o) => o.corruptionSuspected);

  if (corrupt.length > 0) {
    // Not a "could not evict" condition — evidence that a copy somewhere is
    // wrong, which should reach a person rather than merely suppressing a
    // deletion.
    return `${corrupt.length} object(s) disagree with the copy in the cloud about their size or checksum. Nothing was removed for those.`;
  }
  if (!outcomes.some((o) => o.triggered)) {
    return "Everything is inside its budget — nothing needed removing.";
  }
  if (freed === 0) {
    return `Nothing could be removed: ${kept} item(s) are pinned or not yet confirmed to exist anywhere else.`;
  }
  return (
    `Freed ${formatBytes(freed)}` +
    (kept > 0 ? `, and kept ${kept} that are pinned or not confirmed elsewhere.` : ".")
  );
}

/**
 * What the last automatic pass did, in one line.
 *
 * The decline leads when there is one, because it is the half that did not
 * happen and the only place on this screen that would ever mention it. What did
 * happen follows, so a person can tell "nothing new to bring in" apart from
 * "did not look".
 */
function describeCatchUp(last: {
  readonly plan: CatchUpPlan;
  readonly imported: ImportOutcome | null;
}): string {
  const added = last.imported?.imported ?? 0;
  const found =
    added > 0
      ? `Brought in ${added} new item${added === 1 ? "" : "s"}.`
      : last.plan.import
        ? "Nothing new on this device to bring in."
        : null;
  return [last.plan.declined, found].filter(Boolean).join(" ");
}

function describeImport(outcome: ImportOutcome): string {
  const parts: string[] = [];
  if (outcome.imported > 0) parts.push(`added ${outcome.imported}`);
  if (outcome.skipped > 0) parts.push(`${outcome.skipped} already here`);
  if (outcome.failed > 0) parts.push(`${outcome.failed} could not be read`);
  if (parts.length === 0) return "Nothing on this device to add.";
  return `${parts.join(", ")} — of ${outcome.scanned} looked at.`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}
