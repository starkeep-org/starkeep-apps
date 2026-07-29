import { NextResponse } from "next/server";
import { readVisionConfig } from "@/vision/config";
import { modelDownloadState } from "@/vision/model-download";
import {
  FACE_MODEL_PACK,
  FACE_MODELS,
  FACE_MODELS_TOTAL_BYTES,
  faceModelStatus,
} from "@/vision/models";
import { remoteNotImplemented } from "@/vision/remote";
import { currentScanState, isScanning, workerBundlePath } from "@/vision/scan-controller";
import { listSidecarRecordIds, readAllFaceSidecars } from "@/vision/sidecars";
import { readPeople } from "@/vision/people";
import { existsSync } from "node:fs";

export const runtime = "nodejs";
// Every field here is read off local disk, so a cached render would report a
// finished scan as still running.
export const dynamic = "force-dynamic";

/**
 * GET /api/vision/status — everything the Settings panel and Scan card need in
 * one poll: whether the feature can run at all, and how far the last pass got.
 *
 * The counts come from the sidecar store rather than a separate index, which is
 * why they cannot disagree with the results themselves.
 */
export async function GET(): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const models = faceModelStatus();
  const sidecars = readAllFaceSidecars();
  let facesFound = 0;
  let imagesWithFaces = 0;
  for (const sidecar of sidecars.values()) {
    facesFound += sidecar.faces.length;
    if (sidecar.faces.length > 0) imagesWithFaces++;
  }
  const people = readPeople();

  return NextResponse.json({
    config: readVisionConfig(),
    models: {
      installed: models.installed,
      missing: models.missing,
      dir: models.dir,
      fetchCommand: "pnpm vision:fetch-models",
      // Folded in here rather than given its own poll: the panel is already
      // asking this route every second while something is in flight, and two
      // endpoints would let the progress bar and the "installed" flag it
      // resolves into come from different instants.
      download: modelDownloadState(),
      missingBytes: models.missingBytes,
      // What is installed, named — the panel shows this as a standing badge, so
      // "which weights am I actually running?" is answerable without a shell.
      pack: {
        name: FACE_MODEL_PACK,
        files: FACE_MODELS.map((model) => model.fileName),
        totalBytes: FACE_MODELS_TOTAL_BYTES,
      },
    },
    worker: {
      built: existsSync(workerBundlePath()),
      path: workerBundlePath(),
      buildCommand: "pnpm vision:build-worker",
    },
    scan: { ...currentScanState(), running: isScanning() },
    store: {
      // Sidecars this build would not rewrite, versus every sidecar on disk —
      // a gap between the two means stale results waiting to be reprocessed.
      processed: sidecars.size,
      sidecarsOnDisk: listSidecarRecordIds().length,
      imagesWithFaces,
      facesFound,
      people: people.length,
      namedPeople: people.filter((p) => p.name.trim() !== "").length,
    },
  });
}
