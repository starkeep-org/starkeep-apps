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

import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
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
import { useLibrary, useNode } from "./use-library";

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
  const node = useNode();
  const library = useLibrary(node);

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
          <Text style={styles.title}>Starkeep</Text>
          <Text style={styles.subtitle}>{sessionLabel(session, sessionKnown)}</Text>
        </View>

        <Section title="This node's library">
          <LibraryGrid items={library.items} loading={library.loading} />
          {library.error ? <Text style={styles.error}>{library.error}</Text> : null}
          {node.status === "ready" ? (
            <Pressable
              onPress={() => void library.importNow()}
              disabled={library.importing}
              style={[styles.button, library.importing ? styles.buttonDisabled : null]}
            >
              <Text style={styles.buttonLabel}>
                {library.importing ? "Adding…" : "Add photos from this device"}
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
