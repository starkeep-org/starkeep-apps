/**
 * The derivation worker: one `worker_threads` thread that sweeps the library
 * and publishes the renditions each record is missing.
 *
 * ⚠ **Never import this from `app/`.** It is the entry point that pulls in
 * sharp. The controller starts it by absolute path
 * (`.derivation/derive-worker.mjs`, produced by `pnpm derive:build-worker`),
 * which is what keeps a native module out of open-next's dependency trace for
 * every route.
 *
 * ## Why a worker and not a request
 *
 * The gap this closes is between the folder watcher and *the browser*. The
 * watcher lives in the always-on local data server; derivation was fired from a
 * React effect in a tab. So a bulk copy into a watched folder produced a library
 * of originals with no renditions and no queued work — until somebody opened
 * the app, at which point the grid became a producer and the user waited.
 *
 * The Next server, on the other hand, is already a long-lived supervised
 * process: admin-web spawns it detached from the manifest's `localRun` block,
 * records its pid, and it runs until explicitly stopped. Its lifetime is the
 * operator's session on the machine, not the tab's. So there is no new process
 * and no new manifest slot here — only a thread inside one that already exists,
 * exactly as `vision/engine/scan-worker.ts` already does.
 *
 * A thread rather than the request path because this is minutes to hours of
 * CPU, and sharp's decode and encode are enough to make the grid stutter for
 * the whole sweep if they share the loop that serves it.
 */

import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadAppCredentials, signedFetch, type AppCredentials } from "@starkeep/app-client";
import { deriveAndPublish } from "../../photos-lib/image-processing/derive-and-publish";
import { createSipsDecoder } from "../../photos-lib/image-processing/platform-decoder";
import { deriveAndPublishVideo, isTerminalVideoError } from "../../photos-lib/video/derive-and-publish";
import { createFfmpegTools } from "../../photos-lib/video/video-tools";
import { RENDITION_LABEL_REF } from "../../photos-lib/image-processing/publish-renditions";
import {
  CHEAP_STILL_CLASSES,
  CHEAP_TARGET_LONG_EDGE,
  STILL_LADDER,
  type SizeClass,
} from "../../photos-lib/ladder";
import { fileAttemptStore } from "../attempt-store";
import { readSweepState, writeSweepState } from "../sweep-state";
import { fetchSweepPage, stageHasWork, type SweepRecord } from "../sweep-set";
import { emptySweepState, SWEEP_STAGES, type SweepStage, type SweepState } from "../types";
import { PROGRESS_INTERVAL_MS, type SweepCommand, type SweepEvent } from "../worker-protocol";

const MEDIUM_TARGET_LONG_EDGE = STILL_LADDER.find(
  (spec) => spec.sizeClass === "image-medium",
)!.maxLongEdge;
const MEDIUM_CLASS = STILL_LADDER.find((spec) => spec.maxLongEdge === MEDIUM_TARGET_LONG_EDGE)!.sizeClass;
const FULL_STILL_CLASSES = STILL_LADDER
  .filter((spec) => spec.maxLongEdge > MEDIUM_TARGET_LONG_EDGE)
  .map((spec) => spec.sizeClass);

/** Cancellation is cooperative: the loop checks between records. */
let stopRequested = false;
let running = false;

function post(event: SweepEvent): void {
  parentPort?.postMessage(event);
}

/**
 * How wide sharp may spread one encode.
 *
 * Concurrency at the *record* level buys nothing past two — measured at 35.8,
 * 29.7, 28.7, 28.7 and 30.3 seconds for one, two, three, four and seven
 * concurrent items — because the work is CPU-bound and sharp already threads
 * across cores. So the number to control is not how many records run at once
 * but how much of the machine each one takes.
 *
 * Two reasons to leave headroom, both real. The local data server is
 * single-threaded and is serving tiles to whoever is looking at the grid; and
 * the operator is using this laptop for something else.
 */
function capSharpThreads(): void {
  void (async () => {
    const { default: sharp } = await import("sharp");
    const cores = (await import("node:os")).cpus().length;
    sharp.concurrency(Math.max(1, Math.floor(cores / 2)));
  })();
}

async function runSweep(command: Extract<SweepCommand, { type: "start" }>): Promise<void> {
  capSharpThreads();

  const creds = await loadAppCredentials("photos");
  if (!creds) {
    throw new Error("photos has not been installed locally — run install from admin-web");
  }

  const state: SweepState = {
    ...emptySweepState(),
    running: true,
    completed: false,
    startedAt: new Date().toISOString(),
    stage: command.resume.stage,
    cursor: command.resume.cursor,
  };
  writeSweepState(state);
  post({ type: "progress", state });

  let lastProgress = 0;
  const tick = (force = false) => {
    if (!force && Date.now() - lastProgress < PROGRESS_INTERVAL_MS) return;
    lastProgress = Date.now();
    writeSweepState(state);
    post({ type: "progress", state });
  };

  // Stages run in order and are resumed at whichever one the last pass stopped
  // in — the cheap rungs for the whole library before the expensive rungs for
  // any of it. The bottom two rungs for an entire library measured at half a
  // second against nearly thirty for the full ladder, so this is the difference
  // between a grid that fills immediately and one that fills last.
  const startIndex = Math.max(0, SWEEP_STAGES.indexOf(command.resume.stage));
  for (let i = startIndex; i < SWEEP_STAGES.length; i++) {
    const stage = SWEEP_STAGES[i]!;
    // Only the stage being resumed keeps its cursor; later stages start at the
    // top of the library.
    let cursor = i === startIndex ? command.resume.cursor : null;
    state.stage = stage;

    do {
      if (stopRequested) {
        state.cursor = cursor;
        finish(state, null, false);
        return;
      }
      const page = await fetchSweepPage(
        (path) => signedFetch(creds, path),
        RENDITION_LABEL_REF,
        cursor,
      );
      const work = page.records.filter((r) => stageHasWork(r, stage, CHEAP_STILL_CLASSES));
      console.log(
        `[derive] stage=${stage} records=${page.records.length} work=${work.length} ` +
          `cursor=${cursor ?? "start"}`,
      );
      state.examined += page.records.length;
      state.skipped += page.records.length - work.length;

      await inBatches(work, stage === "video" ? 1 : command.concurrency, async (record) => {
        if (stopRequested) return;
        await deriveOne(creds, record, stage, state);
        tick();
      });

      // The cursor advances only after the page's work is done, so a process
      // killed mid-page redoes that page rather than skipping it. Redoing is
      // cheap — a derived record costs two queries — and skipping is a hole
      // nothing else would ever notice.
      cursor = page.nextCursor;
      state.cursor = cursor;
      tick();
    } while (cursor !== null);

    state.cursor = null;
  }

  finish(state, null, true);
}

async function deriveOne(
  creds: AppCredentials,
  record: SweepRecord,
  stage: SweepStage,
  state: SweepState,
): Promise<void> {
  const startedAt = Date.now();
  try {
    if (stage === "video") {
      await deriveOneVideo(creds, record, state);
      return;
    }
    const result = await deriveAndPublish({
      signedFetch: (path, init) => signedFetch(creds, path, init),
      parent: {
        id: record.id,
        originalFilename: record.original_filename,
        mimeType: record.mime_type ?? record.type ?? null,
      },
      loadSource: () => fetchSourceBytes(creds, record.id),
      // Targeted derivation includes the cheap rungs in its wanted set, while
      // existing-rendition detection keeps later passes disjoint in practice.
      ...(stage === "cheap"
        ? { targetLongEdge: CHEAP_TARGET_LONG_EDGE }
        : stage === "medium"
          ? { targetLongEdge: MEDIUM_TARGET_LONG_EDGE }
          : {}),
      onlyRenditionClasses:
        stage === "cheap"
          ? CHEAP_STILL_CLASSES
          : stage === "medium"
            ? [MEDIUM_CLASS]
            : FULL_STILL_CLASSES,
      // The difference between the operator's primary capture format being
      // derivable on this machine or not: macOS ships a licensed HEVC decoder,
      // and the prebuilt sharp does not.
      platformDecoder: createSipsDecoder(),
      attempts: fileAttemptStore(),
      availableRenditionClasses: locallyAvailableClasses(record),
    });

    console.log(
      `[derive] record=${record.id} stage=${stage} outcome=${result.outcome} ` +
        `published=${result.published.map((item) => item.sizeClass).join(",") || "none"} ` +
        `elapsedMs=${Date.now() - startedAt}`,
    );
    if (result.outcome === "undecodable-here") state.undecodable++;
    else if (result.outcome === "complete") {
      if (result.published.length > 0) state.derived++;
    } else state.failed++;
  } catch (err) {
    // One unreadable photo must not end a 60,000-image pass. It is counted and
    // retried on the next one, since nothing was written for it.
    state.failed++;
    console.warn(`[derive] record=${record.id} stage=${stage} elapsedMs=${Date.now() - startedAt} failed:`, err);
  }
}

async function deriveOneVideo(
  creds: AppCredentials,
  record: SweepRecord,
  state: SweepState,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "photos-video-source-"));
  const path = join(dir, basename(record.original_filename ?? `${record.id}.video`));
  try {
    await downloadSourceFile(creds, record.id, path);
    const result = await deriveAndPublishVideo(
      path,
      { id: record.id, originalFilename: record.original_filename },
      {
        signedFetch: (requestPath, init) => signedFetch(creds, requestPath, init),
        tools: createFfmpegTools(),
        keyFor: async (bytes, rendition) => {
          const contentHash = createHash("sha256").update(bytes).digest("hex");
          return {
            contentHash,
            objectStorageKey: `shared/${rendition.type}/${contentHash.slice(0, 2)}/${contentHash}`,
          };
        },
        availableRenditionClasses: locallyAvailableClasses(record),
      },
    );
    if (result.published.length > 0) state.derived++;
    if (result.failed.length > 0) state.failed++;
  } catch (error) {
    if (isTerminalVideoError(error)) state.undecodable++;
    else state.failed++;
    console.warn(`[derive-video] ${record.id} failed:`, error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function locallyAvailableClasses(record: SweepRecord): SizeClass[] {
  return (record.variant_candidates ?? [])
    .filter(
      (candidate): candidate is typeof candidate & { label_value: SizeClass } =>
        candidate.available_here && Boolean(candidate.label_value),
    )
    .map((candidate) => candidate.label_value);
}

async function downloadSourceFile(
  creds: AppCredentials,
  recordId: string,
  destination: string,
): Promise<void> {
  const urlRes = await signedFetch(creds, `/data/records/${recordId}/file-url`);
  if (!urlRes.ok) throw new Error(`file-url failed: ${urlRes.status}`);
  const { url } = (await urlRes.json()) as { url: string };
  const fileRes = await fetch(url);
  if (!fileRes.ok || !fileRes.body) throw new Error(`file fetch failed: ${fileRes.status}`);
  await pipeline(Readable.fromWeb(fileRes.body as never), createWriteStream(destination));
}

async function fetchSourceBytes(creds: AppCredentials, recordId: string): Promise<Uint8Array> {
  const urlRes = await signedFetch(creds, `/data/records/${recordId}/file-url`);
  if (!urlRes.ok) throw new Error(`file-url failed: ${urlRes.status}`);
  const { url } = (await urlRes.json()) as { url: string };
  // A self-signed token URL — no HMAC needed, same as the resize route.
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error(`file fetch failed: ${fileRes.status}`);
  return new Uint8Array(await fileRes.arrayBuffer());
}

/** Run `limit` at a time, in order, waiting for each group. */
async function inBatches<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(run));
  }
}

function finish(state: SweepState, error: string | null, completed: boolean): void {
  state.running = false;
  state.completed = completed;
  state.finishedAt = new Date().toISOString();
  state.error = error;
  writeSweepState(state);
  post({ type: "finished", state });
  retire();
}

/**
 * End the thread once the sweep is over.
 *
 * Not an optimisation — the host equates "I hold a worker" with "a sweep is
 * running", so a worker that idles after finishing leaves the status endpoint
 * reporting a running sweep forever and every subsequent start rejected as a
 * duplicate.
 *
 * `close()` rather than `process.exit()` so the messages posted above are still
 * delivered.
 */
function retire(): void {
  parentPort?.close();
}

parentPort?.on("message", (command: SweepCommand) => {
  if (command.type === "stop") {
    stopRequested = true;
    return;
  }
  if (running) return;
  running = true;
  stopRequested = false;
  void runSweep(command)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const state = readSweepState();
      state.running = false;
      state.completed = false;
      state.finishedAt = new Date().toISOString();
      state.error = message;
      writeSweepState(state);
      post({ type: "failed", message });
      retire();
    })
    .finally(() => {
      running = false;
    });
});
