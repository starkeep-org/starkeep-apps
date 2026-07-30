/**
 * Fetches a model group from inside the Next server, so the Vision panel can
 * offer the download instead of printing a command.
 *
 * `pnpm vision:fetch-models` still exists and still works — this is the same
 * manifest, the same pinned URLs, and the same `verifiedDownload` — but a user
 * who opened Photos from the launcher does not have a terminal in front of them,
 * and "run this in a shell" is where the feature ended for them.
 *
 * Progress is deliberately **in memory only**. It describes an in-flight
 * transfer, not state: a server restart mid-download leaves a `.download`
 * temporary that the next attempt removes, and the panel re-derives "not
 * installed" from the files themselves. A progress file would be one more thing
 * that can disagree with the disk.
 *
 * Whether a model *is* installed is never asked here — `groupModelStatus()` reads
 * the directory, and it stays the single answer to that question. The rename
 * into place happens last, so a download in flight cannot read as installed.
 *
 * **One transfer at a time, across all groups.** Not a limitation to work around:
 * these are hundreds of megabytes each and running them concurrently would make
 * both slower and the progress bar meaningless. `group` records which one is in
 * flight so the panel can put the bar on the right card.
 */

import { mkdirSync } from "node:fs";
import { writeLicenceAcknowledgement } from "./licence";
import {
  groupModelStatus,
  MODEL_GROUPS,
  type ModelGroup,
  type VisionModel,
} from "./models";
import { modelPath, modelsDir } from "./paths";
import { verifiedDownload } from "./verified-download";

export interface ModelDownloadState {
  running: boolean;
  /** Which group is in flight, or was last. Null before anything has been tried. */
  group: ModelGroup | null;
  /** Verified bytes on disk plus bytes of the file in flight. */
  bytesReceived: number;
  /** Sum of the sizes this run set out to fetch. */
  bytesTotal: number;
  /** The file being transferred, for a panel that wants to name it. */
  currentFile: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Downloader {
  state: ModelDownloadState;
}

/** Survives hot reload — see the same pattern's rationale in `scan-controller.ts`. */
const DOWNLOADER_KEY = Symbol.for("starkeep.photos.vision.modelDownload");

function idleState(): ModelDownloadState {
  return {
    running: false,
    group: null,
    bytesReceived: 0,
    bytesTotal: 0,
    currentFile: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function downloader(): Downloader {
  const globals = globalThis as unknown as Record<symbol, Downloader | undefined>;
  let existing = globals[DOWNLOADER_KEY];
  if (!existing) {
    existing = { state: idleState() };
    globals[DOWNLOADER_KEY] = existing;
  }
  return existing;
}

export function modelDownloadState(): ModelDownloadState {
  return downloader().state;
}

export interface StartDownloadOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export type StartDownloadResult =
  | { ok: true; download: ModelDownloadState }
  | { ok: false; status: number; error: string };

/**
 * Kicks off the missing models and returns immediately; the panel polls
 * `/api/vision/status` for progress.
 *
 * Only what is missing, so a run interrupted after the 17 MB detector does not
 * re-fetch it — and so `bytesTotal` is the number of bytes this run will
 * actually move rather than the size of the full pair.
 */
export function startModelDownload(
  group: ModelGroup,
  options: StartDownloadOptions = {},
): StartDownloadResult {
  const self = downloader();
  if (self.state.running) {
    return { ok: false, status: 409, error: "a model download is already running" };
  }

  const info = MODEL_GROUPS[group];
  const status = groupModelStatus(group);
  if (status.installed) {
    return { ok: false, status: 409, error: `the ${group} models are already installed` };
  }

  const pending = info.models.filter((model) => status.missing.includes(model.fileName));
  self.state = {
    ...idleState(),
    running: true,
    group,
    bytesTotal: pending.reduce((sum, model) => sum + model.sizeBytes, 0),
    startedAt: new Date().toISOString(),
  };

  mkdirSync(modelsDir(), { recursive: true });
  // Only for a group that actually carries a restriction. Recording an
  // acknowledgement for the Apache-2.0 weights would misstate what was agreed to,
  // and recording it here at all — before the bytes land — is so that an
  // interrupted download still leaves the record of the decision.
  if (info.needsAck) writeLicenceAcknowledgement(`the Photos ${info.label} panel`);

  void run(self, pending, options.fetchImpl);
  return { ok: true, download: self.state };
}

async function run(
  self: Downloader,
  pending: VisionModel[],
  fetchImpl?: typeof fetch,
): Promise<void> {
  let completed = 0;
  try {
    for (const model of pending) {
      self.state = { ...self.state, currentFile: model.fileName };
      await verifiedDownload({
        url: model.url,
        target: modelPath(model.fileName),
        sha256: model.sha256,
        fetchImpl,
        // Replaced rather than accumulated: the object is what the next status
        // poll serializes, and mutating it in place would let a poll observe a
        // half-updated frame.
        onProgress: (seen) => {
          self.state = { ...self.state, bytesReceived: completed + seen };
        },
      });
      completed += model.sizeBytes;
      self.state = { ...self.state, bytesReceived: completed };
    }
    self.state = {
      ...self.state,
      running: false,
      currentFile: null,
      finishedAt: new Date().toISOString(),
    };
  } catch (err) {
    // A digest mismatch has already deleted its temporary, so "failed" and
    // "nothing half-installed" are the same state — the panel can offer a
    // straight retry.
    self.state = {
      ...self.state,
      running: false,
      currentFile: null,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
