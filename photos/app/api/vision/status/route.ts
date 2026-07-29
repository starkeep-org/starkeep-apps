import { NextResponse } from "next/server";
import { readVisionConfig } from "@/vision/config";
import { faceModelStatus } from "@/vision/models";
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
