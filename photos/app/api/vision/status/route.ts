import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { readVisionConfig } from "@/vision/config";
import { modelDownloadState } from "@/vision/model-download";
import {
  groupModelStatus,
  groupTotalBytes,
  MODEL_GROUPS,
  searchModelStatus,
  type ModelGroup,
} from "@/vision/models";
import { remoteNotImplemented } from "@/vision/remote";
import { currentScanState, isScanning, workerBundlePath } from "@/vision/scan-controller";
import { isQueryWorkerRunning, queryWorkerBundlePath } from "@/vision/search/query-controller";
import { readSceneIndex } from "@/vision/scene-index";
import {
  listTaskRecordIds,
  readAllFaceSidecars,
  taskProcessedRecordIds,
} from "@/vision/sidecars";
import { readPeople } from "@/vision/people";

export const runtime = "nodejs";
// Every field here is read off local disk, so a cached render would report a
// finished scan as still running.
export const dynamic = "force-dynamic";

/**
 * GET /api/vision/status — everything the Settings panel and Scan card need in
 * one poll: which tasks can run at all, and how far the last pass got.
 *
 * **Per task rather than one top-level block** (plan §3.5). The face-shaped
 * version put `imagesWithFaces` / `facesFound` / `people` at the root, which had
 * nowhere to put scene's counts and no way to say which task's models were
 * missing. Each task now reports its own model status and its own store, so the
 * panel renders a card per task without the route deciding how many there are.
 *
 * The counts still come from the sidecar store rather than a separate index,
 * which is why they cannot disagree with the results themselves.
 */
export async function GET(): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const faceSidecars = readAllFaceSidecars();
  let facesFound = 0;
  let imagesWithFaces = 0;
  for (const sidecar of faceSidecars.values()) {
    facesFound += sidecar.faces.length;
    if (sidecar.faces.length > 0) imagesWithFaces++;
  }
  const people = readPeople();

  // Read once: the header carries the row count, so this is a small read even with
  // a large index, and it is the only honest answer to "is search ready".
  const index = readSceneIndex();

  return NextResponse.json({
    config: readVisionConfig(),
    worker: {
      built: existsSync(workerBundlePath()),
      path: workerBundlePath(),
      buildCommand: "pnpm vision:build-worker",
    },
    scan: { ...currentScanState(), running: isScanning() },
    // One transfer at a time across all groups, so this stays singular — `group`
    // says which card the progress bar belongs to.
    download: modelDownloadState(),
    tasks: {
      faces: {
        models: groupModels("faces"),
        store: {
          // Sidecars this build would not rewrite, versus every sidecar on disk —
          // a gap between the two means stale results waiting to be reprocessed.
          processed: faceSidecars.size,
          sidecarsOnDisk: listTaskRecordIds("faces").length,
          imagesWithFaces,
          facesFound,
          people: people.length,
          namedPeople: people.filter((p) => p.name.trim() !== "").length,
        },
      },
      scene: {
        models: groupModels("scene"),
        store: {
          processed: taskProcessedRecordIds("scene").size,
          sidecarsOnDisk: listTaskRecordIds("scene").length,
          /** Rows in the compacted index — what search actually ranks against. */
          indexed: index?.recordIds.length ?? 0,
          /** False when the index is absent or was built by another model. */
          indexReady: index !== null,
        },
      },
    },
    search: {
      models: groupModels("search"),
      // Not a health check — the worker exits itself when idle, so "not running" is
      // the normal resting state and says nothing about whether search works.
      workerRunning: isQueryWorkerRunning(),
      workerBuilt: existsSync(queryWorkerBundlePath()),
      ready: searchModelStatus().installed && (index?.recordIds.length ?? 0) > 0,
    },
  });
}

function groupModels(group: ModelGroup) {
  const status = groupModelStatus(group);
  const info = MODEL_GROUPS[group];
  return {
    installed: status.installed,
    missing: status.missing,
    missingBytes: status.missingBytes,
    dir: status.dir,
    fetchCommand: `pnpm vision:fetch-models --${group}`,
    licence: info.licence,
    needsAck: info.needsAck,
    label: info.label,
    purpose: info.purpose,
    // What is installed, named — shown as a standing badge, so "which weights am I
    // actually running?" is answerable without a shell.
    pack: {
      name: info.pack,
      files: info.models.map((model) => model.fileName),
      totalBytes: groupTotalBytes(group),
    },
  };
}
