/**
 * Where Photos keeps its on-device vision state.
 *
 * `$STARKEEP_DIR/app-local/photos/vision/` — deliberately outside both homes
 * the platform gives an app, because both of those sync unconditionally and
 * none of this may leave the device (face-recognition-plan.md §3). The
 * convention is named in core's `system-design.md` under "No platform-managed
 * scratch space"; the platform does not create, enumerate, or clean it up, so
 * an uninstall leaves it behind.
 *
 * The downloads are the exception: model weights and test photographs live
 * under `$STARKEEP_DIR/app-assets/photos/vision/` because they are
 * re-fetchable content rather than user data. See `visionAssetsDir()`.
 *
 * Nothing here imports onnxruntime — this module is safe for the Next server
 * graph. See `engine/` for the part that is not.
 */

import { join } from "node:path";
import { starkeepAssetsDir, starkeepDir } from "@starkeep/app-client";

/** Root of Photos' non-syncable, on-device state. */
export function visionDir(): string {
  return join(starkeepDir(), "app-local", "photos", "vision");
}

/**
 * Root of the vision downloads: the ONNX graphs and the test photographs, each
 * SHA-pinned and fetched by a `pnpm vision:fetch-*` script.
 *
 * These sit under `app-assets/` rather than beside the rest of the vision state
 * because they are not state — `rm -rf` costs a re-download and nothing else.
 * That is also why they are the one part of vision resolved through core's
 * unguarded root: a test asking "are the models installed?" has to be allowed
 * to look at the real answer, or it skips itself forever while reporting green.
 */
export function visionAssetsDir(): string {
  return join(starkeepAssetsDir(), "photos", "vision");
}

/** ONNX graphs, fetched by `pnpm vision:fetch-models`. Gitignored, never synced. */
export function modelsDir(): string {
  return join(visionAssetsDir(), "models");
}

export function modelPath(fileName: string): string {
  return join(modelsDir(), fileName);
}

/** Toggles and thresholds. */
export function configPath(): string {
  return join(visionDir(), "config.json");
}

/**
 * One sidecar per processed record. The sidecar's *existence* is the
 * processed-state — there is no separate index that could drift from it, and an
 * image with no faces still gets one (with `faces: []`) so
 * processed-with-zero-results stays distinguishable from unprocessed.
 */
export function facesDir(): string {
  return join(visionDir(), "faces");
}

export function faceSidecarPath(recordId: string): string {
  return join(facesDir(), `${recordId}.json`);
}

/** Named clusters. Membership itself lives as `personId` on each sidecar face. */
export function peoplePath(): string {
  return join(visionDir(), "people.json");
}

/** Progress of the last/current pass. */
export function scanStatePath(): string {
  return join(visionDir(), "scan-state.json");
}
