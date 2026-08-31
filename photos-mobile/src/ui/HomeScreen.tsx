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
 * What is still missing is stated rather than implied: nothing on this screen
 * has been imported into the node, and nothing has synced — the cloud data
 * plane needs a per-app HMAC secret no handset can hold. An empty-looking
 * library would quietly attribute both to "you have no photos".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
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
import type { ImportOutcome } from "../media/import";
import { formatBytes, LibraryGrid } from "./LibraryGrid";
import { MediaGrid } from "./MediaGrid";
import { styles } from "./theme";
import { useLibrary, useNode, useStorage } from "./use-library";
import type { EvictionOutcome } from "@starkeep/sync-engine";
import { describeVerify, verifyFoundProblem } from "./verify-text";
import type { VerifyResult } from "@starkeep/sync-engine";

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
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") syncAbort.current?.abort();
    });
    return () => {
      subscription.remove();
      syncAbort.current?.abort();
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

  // Assumed conditions until item 13 reports the real ones. Stated as assumed
  // rather than shown as measured: a status screen that quietly makes things up
  // is worse than one that admits what it does not know.
  const assumedDevice: DeviceState = {
    hasNetwork: true,
    isUnmetered: true,
    isCharging: false,
    isStorageLow: false,
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
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
      >
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>Starkeep Photos</Text>
          <Text style={styles.subtitle}>{sessionLabel(session, sessionKnown)}</Text>
        </View>

        <Section title="This node's library">
          <LibraryGrid
            items={library.items}
            loading={library.loading}
            onFetch={library.fetchBlob}
            onSetPinned={library.setPinned}
            isPinned={library.isPinned}
            onOpened={library.noteOpened}
          />
          {library.error ? <Text style={styles.error}>{library.error}</Text> : null}
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
        </Section>

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
          <MediaGrid media={deviceMedia} />
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
            {JOB_GRAPH.length} jobs declared, {runnableJobs(assumedDevice).length} runnable under
            assumed conditions. None are scheduled yet — WorkManager binding is item 14, and device
            conditions are assumed until item 13 reports them.
          </Text>
        </Section>

        <Section title="Sync">
          {node.status === "ready" ? (
            <>
              <Pressable
                onPress={() => {
                  setSyncing(true);
                  setSyncProgress(null);
                  // sync(), not exchange(): a round carries at most one round's
                  // budget, so one tap per round would make a first upload of a
                  // real library hundreds of taps. Abandoning mid-loop is free —
                  // each round persists its own watermarks — so backgrounding
                  // the app costs at most the round in flight.
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
                      },
                    })
                    .then(async (result) => {
                      // A stalled sync is not an error and not a success: the
                      // loop stopped because a round achieved nothing while work
                      // was still outstanding, which in practice is a transfer
                      // that will not go through. Saying nothing would show the
                      // same quiet "Sync now" as a completed sync.
                      setSyncError(
                        result?.stalled
                          ? "Sync stopped making progress — something could not transfer. It will retry."
                          : result?.refusedAuthors?.length
                            ? "Some of this device's records are not reaching the cloud. Check backup to try again."
                            : result?.peerCoverageDegraded
                              ? `The cloud could not report what it holds (${result.peerCoverageDegraded}), so this sync was conservative.`
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
                    .finally(() => setSyncing(false));
                }}
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

        <Section title="Not yet">
          <Text style={styles.muted}>
            Nothing on this device has synced anywhere, and cannot yet: the cloud data plane signs
            every request with a per-app secret a handset has no way to hold. So this node is the
            only one that knows what it holds, and its photos have no second copy. Renditions are
            not being derived either — nothing would read them until there is somewhere to send
            them.
          </Text>
        </Section>
      </ScrollView>
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
