/**
 * What a headless launch can actually do — measured, not assumed.
 *
 * ## Why this file exists
 *
 * Binding work to WorkManager rests on four expectations about the JavaScript
 * context Expo starts when the app is not running, and none of them had been
 * observed on a handset:
 *
 * 1. The bundle evaluates at all — `react-native-get-random-values` installs a
 *    PRNG, op-sqlite loads, `expo-file-system` resolves the document directory.
 * 2. `expo-media-library` answers a query with no activity behind it.
 * 3. `File.upload` carries bytes from a `content://` asset with no activity
 *    behind it either.
 * 4. A sync needs no Cognito session, because the Drive channel signs with the
 *    device's own key.
 *
 * Each step below settles exactly one of them, in that order, and the order is
 * the point: a step that fails leaves every later step unattempted and unmixed
 * into the result. The report names the step that stopped it.
 *
 * ## Why the result is persisted rather than logged
 *
 * Logcat is available with a cable attached and nowhere else, and the whole
 * question is what the phone does when nobody is watching. The report is
 * written to a file the next foreground launch reads, so the answer survives
 * the process that produced it.
 *
 * This file is a measurement rather than a feature, and it comes out once the
 * four questions have answers.
 */

import type { MobileNode } from "../node";
import type { DeviceMediaModule } from "../media/device-library";
import { listRecentMedia } from "../media/device-library";
import { summarizeLibrary } from "../library";

/** One step's outcome. `detail` is what a person reads to know what happened. */
export interface ProbeStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}

export interface ProbeReport {
  /** When the headless context ran, as the device's clock saw it. */
  readonly startedAt: string;
  readonly steps: readonly ProbeStep[];
  readonly totalMs: number;
}

export interface ProbeDeps {
  readonly media: DeviceMediaModule;
  readonly openNode: () => Promise<MobileNode>;
  readonly now?: () => number;
  /** Where the report goes, so the next foreground launch can read it. */
  readonly writeReport: (report: ProbeReport) => void;
  readonly log?: (line: string) => void;
}

/**
 * How long the probe's sync half may run.
 *
 * Well under WorkManager's ten-minute ceiling, because the question here is
 * whether a transfer happens at all rather than how much of the library moves.
 * A probe that ran to the ceiling would be indistinguishable from a probe that
 * hung.
 */
export const PROBE_SYNC_MS = 90_000;

/**
 * Run every step, stopping at the first failure.
 *
 * Never throws. A probe whose whole purpose is to report what a headless
 * context does must not become the thing that crashes it — an exception here
 * would be reported by WorkManager as a failed worker and by nothing else.
 */
export async function runProbe(deps: ProbeDeps): Promise<ProbeReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const start = now();
  const steps: ProbeStep[] = [];
  let node: MobileNode | null = null;

  const step = async (name: string, run: () => Promise<string>): Promise<boolean> => {
    const began = now();
    try {
      const detail = await run();
      steps.push({ name, ok: true, detail, ms: now() - began });
      log(`[bg-probe] ${name}: OK — ${detail}`);
      return true;
    } catch (err) {
      steps.push({ name, ok: false, detail: String(err), ms: now() - began });
      log(`[bg-probe] ${name}: FAILED — ${String(err)}`);
      return false;
    }
  };

  log(`[bg-probe] headless context awake at ${new Date(start).toISOString()}`);

  try {
    // 1. The bundle evaluated, which reaching this line already proves. Recorded
    // as a step anyway, because a report whose first entry is the media query
    // cannot distinguish "the query failed" from "nothing ran".
    steps.push({
      name: "bundle",
      ok: true,
      detail: `entry evaluated, crypto.getRandomValues ${
        typeof globalThis.crypto?.getRandomValues === "function" ? "present" : "MISSING"
      }`,
      ms: 0,
    });

    const mediaOk = await step("media-library", async () => {
      const permission = await deps.media.getPermissions();
      const items = await listRecentMedia(deps.media, { limit: 5 });
      return `granted=${permission.granted} privileges=${permission.accessPrivileges ?? "unstated"} newest=${items.length} first=${
        items[0]?.filename ?? "none"
      }`;
    });
    if (!mediaOk) return finish();

    const nodeOk = await step("node", async () => {
      node = await deps.openNode();
      const summary = await summarizeLibrary({
        database: node.databaseAdapter,
        objectStorage: node.objectStorage,
        aliases: node.mediaAliases,
      });
      return `records=${summary.records} aliasedBytes=${summary.aliasedBytes} engine=${
        node.engine ? "present" : "null"
      }`;
    });
    if (!nodeOk) return finish();

    await step("sync", async () => {
      const open = node;
      if (open === null) throw new Error("no node");
      if (open.engine === null) return "no cloud configured on this build — nothing to exchange";
      const deadline = start + PROBE_SYNC_MS;
      // A getter rather than a timer: `SyncOptions.signal` is structurally
      // `{ aborted: boolean }` and is read once per round, so the deadline
      // needs nothing running to enforce it.
      const signal = {
        get aborted(): boolean {
          return now() > deadline;
        },
      };
      const result = await open.sync({
        signal,
        onRound: (round, index) =>
          log(
            `[bg-probe] round=${index} applied=${round.applied} shipped=${round.shipped} ` +
              `blocked=${round.blocked} hasMore=${round.hasMore}`,
          ),
      });
      if (result === null) return "sync returned null — this node has no cloud";
      return (
        `rounds=${result.rounds} applied=${result.applied} shipped=${result.shipped} ` +
        `elided=${result.elided} complete=${result.complete} stalled=${result.stalled}`
      );
    });

    return finish();
  } catch (err) {
    // The catch of last resort. Anything reaching here is a defect in the probe
    // rather than an answer about the platform, and it is still reported.
    steps.push({ name: "probe", ok: false, detail: String(err), ms: now() - start });
    return finish();
  } finally {
    // Closed whatever happened, because a headless context that leaves SQLite
    // open hands the next foreground launch a locked database.
    if (node !== null) await (node as MobileNode).close().catch(() => undefined);
  }

  function finish(): ProbeReport {
    const report: ProbeReport = {
      startedAt: new Date(start).toISOString(),
      steps,
      totalMs: now() - start,
    };
    try {
      deps.writeReport(report);
    } catch (err) {
      log(`[bg-probe] could not write the report: ${String(err)}`);
    }
    log(`[bg-probe] done in ${report.totalMs}ms — ${steps.filter((s) => s.ok).length}/${steps.length} steps OK`);
    return report;
  }
}
