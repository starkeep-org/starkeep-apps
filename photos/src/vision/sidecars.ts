/**
 * The sidecar store, parameterized by vision task.
 *
 * Processed-state is the sidecar's *existence*, not a separate index — one
 * `readdir` yields the whole set, counts are free, and there is nothing that
 * could drift out of step with the results themselves. A record the task found
 * nothing in still gets a sidecar (`faces: []` for faces), so "processed, found
 * nothing" and "not yet processed" stay distinguishable, which is the difference
 * between a scan that converges and one that retries the same empty photos
 * forever.
 *
 * What that buys is consistency *within* the store, and it is worth being exact
 * about the limit: the store can still drift from the **library**, because a
 * directory of files cannot express "this belongs to that record". Deleting a
 * record deletes nothing here. `reapOrphanSidecars` is the reconciliation that
 * has to stand in for the cascade, and a scan is the only place with a
 * trustworthy view of what still exists to drive it.
 *
 * A sidecar whose `v` or `model` does not match the current build is treated as
 * absent: that is the whole reprocess mechanism, and it is why swapping models
 * needs no migration. Both halves are **per task** (`TASK_SCHEMAS`) — a scene
 * model swap reprocesses scene and leaves face results alone, which is the
 * property that makes tasks independently reprocessable rather than one shared
 * cache to invalidate wholesale.
 *
 * Everything below is generic over the task; the face-typed facade at the bottom
 * is what the face call sites use, because they want `FaceSidecar` and not
 * `SidecarBase`.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { sidecarPath, taskDir } from "./paths";
import { FACE_MODEL_ID } from "./models";
import {
  FACE_SIDECAR_VERSION,
  VISION_TASK_IDS,
  type FaceSidecar,
  type SidecarBase,
  type VisionTaskId,
} from "./types";

/**
 * What each task's current build writes, and how to tell its payload apart from
 * another task's.
 *
 * Here rather than in `engine/tasks.ts` because the staleness check runs on the
 * `app/` side too — every route serving stored results has to reject a stale
 * sidecar, and the registry over there imports the engine.
 */
interface TaskSchema {
  version: number;
  modelId: string;
  /**
   * Does this parsed JSON carry this task's payload?
   *
   * Not paranoia about hand-edited files: sidecar paths are `<recordId>.json`
   * under a per-task directory, so a payload shape check is the only thing that
   * would notice a directory being read as the wrong task's. It is also what
   * makes a truncated-then-reparsed file fail closed instead of reading as
   * "processed, found nothing".
   */
  hasPayload(parsed: SidecarBase): boolean;
}

/**
 * `Record` over the id union rather than a partial map, so widening
 * `VisionTaskId` for a new task is a compile error until it declares its schema
 * here — the alternative is an `undefined` lookup that reads as "never current"
 * and silently reprocesses every image on every pass.
 */
const TASK_SCHEMAS: Record<VisionTaskId, TaskSchema> = {
  faces: {
    version: FACE_SIDECAR_VERSION,
    modelId: FACE_MODEL_ID,
    hasPayload: (parsed) => Array.isArray((parsed as FaceSidecar).faces),
  },
};

/**
 * The `(version, model)` pair a sidecar must match to count as processed.
 *
 * Rebuilt rather than returned by reference, so the declared type is the whole
 * value — handing out the schema itself would leak `hasPayload` to every caller
 * that only wanted to report what this build writes.
 */
export function taskSchema(taskId: VisionTaskId): { version: number; modelId: string } {
  const { version, modelId } = TASK_SCHEMAS[taskId];
  return { version, modelId };
}

export function readTaskSidecar(taskId: VisionTaskId, recordId: string): SidecarBase | null {
  let parsed: SidecarBase;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath(taskId, recordId), "utf-8")) as SidecarBase;
  } catch {
    return null;
  }
  if (!TASK_SCHEMAS[taskId].hasPayload(parsed)) return null;
  return parsed;
}

/** A sidecar only counts as processed if this build of this task could have written it. */
export function isCurrentFor(taskId: VisionTaskId, sidecar: SidecarBase): boolean {
  const schema = TASK_SCHEMAS[taskId];
  return sidecar.v === schema.version && sidecar.model === schema.modelId;
}

/**
 * Written via a temp file and `rename` because a scan can be stopped — and the
 * process killed — at any point, and a half-written sidecar is indistinguishable
 * from a processed record the task found nothing in. `rename` within a directory
 * is atomic on every platform this runs on.
 */
export function writeTaskSidecar(
  taskId: VisionTaskId,
  recordId: string,
  sidecar: SidecarBase,
): void {
  const path = sidecarPath(taskId, recordId);
  mkdirSync(taskDir(taskId), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sidecar)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function deleteTaskSidecar(taskId: VisionTaskId, recordId: string): void {
  rmSync(sidecarPath(taskId, recordId), { force: true });
}

/** Every record id with a sidecar for this task on disk, current or not. */
export function listTaskRecordIds(taskId: VisionTaskId): string[] {
  let entries: string[];
  try {
    entries = readdirSync(taskDir(taskId));
  } catch {
    return [];
  }
  return entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -".json".length));
}

/**
 * The record ids this task may skip: those with a sidecar this build would not
 * rewrite. Stale-model sidecars are deliberately *not* in the set.
 *
 * Per-task, and that is load-bearing rather than tidy: a single shared
 * processed-set means enabling a second task on an already-scanned library sees
 * every record as done and skips the entire pass.
 */
export function taskProcessedRecordIds(taskId: VisionTaskId): Set<string> {
  const out = new Set<string>();
  for (const id of listTaskRecordIds(taskId)) {
    const sidecar = readTaskSidecar(taskId, id);
    if (sidecar && isCurrentFor(taskId, sidecar)) out.add(id);
  }
  return out;
}

/**
 * Drop sidecars whose record is no longer in the scan set, across **every**
 * task, and report what went.
 *
 * Nothing else reconciles this store with the library. A directory of files has
 * no foreign key to `shared_records` and no cascade to hang off, so a record
 * that goes away leaves its results behind forever — inflating every count the
 * status route folds (`processed`, `imagesWithFaces`, `facesFound`) and, worse,
 * feeding dead embeddings to `assignUnclusteredFaces`, which clusters over the
 * whole store. Re-importing a library therefore doubles every person in it.
 *
 * **Every task, including disabled ones** (`VISION_TASK_IDS`, not the enabled
 * set). A task that is off still has a directory full of results from when it was
 * on; skipping it means deleting photos while it is off leaves orphans that come
 * back to vote the moment it is switched on again. Reaping a disabled task's
 * directory costs one `readdir` that almost always returns nothing.
 *
 * `keep` is the scan set, not the record set — a record that stops being an
 * original (it gains a `photos/crop` label) is reaped too. That is deliberate:
 * its faces are its parent's faces at an offset, so they were never ours to
 * hold, and the alternative is a second listing pass to tell the two cases
 * apart for no behavioural difference.
 *
 * Callers must not pass an empty `keep` for a library that merely failed to
 * list — see the guard at the one call site in `engine/scan-worker.ts`. The guard
 * stays there, once, rather than per task: it is a judgement about whether the
 * *listing* is trustworthy, which is the same judgement for every task.
 */
export function reapOrphanSidecars(keep: ReadonlySet<string>): string[] {
  const reaped: string[] = [];
  for (const taskId of VISION_TASK_IDS) {
    for (const id of listTaskRecordIds(taskId)) {
      if (keep.has(id)) continue;
      deleteTaskSidecar(taskId, id);
      reaped.push(id);
    }
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// The face-typed facade.
//
// Thin by design: these exist so face call sites get `FaceSidecar` rather than
// `SidecarBase`, which is what lets `clustering.ts` and `label-publish.ts` reach
// `.faces` without a cast. New tasks add their own facade beside this one.
// ---------------------------------------------------------------------------

export function readFaceSidecar(recordId: string): FaceSidecar | null {
  return readTaskSidecar("faces", recordId) as FaceSidecar | null;
}

export function isCurrent(sidecar: SidecarBase): boolean {
  return isCurrentFor("faces", sidecar);
}

export function writeFaceSidecar(recordId: string, sidecar: FaceSidecar): void {
  writeTaskSidecar("faces", recordId, sidecar);
}

export function deleteFaceSidecar(recordId: string): void {
  deleteTaskSidecar("faces", recordId);
}

export function listSidecarRecordIds(): string[] {
  return listTaskRecordIds("faces");
}

export function processedRecordIds(): Set<string> {
  return taskProcessedRecordIds("faces");
}

/**
 * Every current face sidecar, keyed by record id.
 *
 * Reads the whole store — a few hundred bytes per photo with no faces, ~1 KB per
 * face — which is what the People view and the label publisher both need, and
 * small enough that paging it would be more machinery than it saves.
 *
 * Note for search (plan §5.5): this shape does *not* generalize to the scene
 * store. Folding 10k JSON files is fine once at end-of-pass and far too slow per
 * query, which is why embeddings get a compacted binary index instead.
 */
export function readAllFaceSidecars(): Map<string, FaceSidecar> {
  const out = new Map<string, FaceSidecar>();
  for (const id of listTaskRecordIds("faces")) {
    const sidecar = readFaceSidecar(id);
    if (sidecar && isCurrent(sidecar)) out.set(id, sidecar);
  }
  return out;
}
