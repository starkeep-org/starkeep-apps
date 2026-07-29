/**
 * The face sidecar store.
 *
 * Processed-state is the sidecar's *existence*, not a separate index — one
 * `readdir` yields the whole set, counts are free, and there is nothing that
 * could drift out of step with the results themselves. A record with no faces
 * still gets a sidecar (`faces: []`), so "processed, found nothing" and "not yet
 * processed" stay distinguishable, which is the difference between a scan that
 * converges and one that retries the same empty photos forever.
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
 * needs no migration.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { facesDir, faceSidecarPath } from "./paths";
import { FACE_MODEL_ID } from "./models";
import { FACE_SIDECAR_VERSION, type FaceSidecar } from "./types";

export function readFaceSidecar(recordId: string): FaceSidecar | null {
  let parsed: FaceSidecar;
  try {
    parsed = JSON.parse(readFileSync(faceSidecarPath(recordId), "utf-8")) as FaceSidecar;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.faces)) return null;
  return parsed;
}

/** A sidecar only counts as processed if this build could have written it. */
export function isCurrent(sidecar: FaceSidecar): boolean {
  return sidecar.v === FACE_SIDECAR_VERSION && sidecar.model === FACE_MODEL_ID;
}

/**
 * Written via a temp file and `rename` because a scan can be stopped — and the
 * process killed — at any point, and a half-written sidecar is indistinguishable
 * from a processed record with no faces. `rename` within a directory is atomic
 * on every platform this runs on.
 */
export function writeFaceSidecar(recordId: string, sidecar: FaceSidecar): void {
  const path = faceSidecarPath(recordId);
  mkdirSync(facesDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sidecar)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function deleteFaceSidecar(recordId: string): void {
  rmSync(faceSidecarPath(recordId), { force: true });
}

/** Every record id with a sidecar on disk, current or not. */
export function listSidecarRecordIds(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(facesDir());
  } catch {
    return [];
  }
  return entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -".json".length));
}

/**
 * The record ids a scan may skip: those with a sidecar this build would not
 * rewrite. Stale-model sidecars are deliberately *not* in the set.
 */
export function processedRecordIds(): Set<string> {
  const out = new Set<string>();
  for (const id of listSidecarRecordIds()) {
    const sidecar = readFaceSidecar(id);
    if (sidecar && isCurrent(sidecar)) out.add(id);
  }
  return out;
}

/**
 * Drop sidecars whose record is no longer in the scan set, and report what went.
 *
 * Nothing else reconciles this store with the library. A directory of files has
 * no foreign key to `shared_records` and no cascade to hang off, so a record
 * that goes away leaves its faces behind forever — inflating every count the
 * status route folds (`processed`, `imagesWithFaces`, `facesFound`) and, worse,
 * feeding dead embeddings to `assignUnclusteredFaces`, which clusters over the
 * whole store. Re-importing a library therefore doubles every person in it.
 *
 * `keep` is the scan set, not the record set — a record that stops being an
 * original (it gains a `photos/crop` label) is reaped too. That is deliberate:
 * its faces are its parent's faces at an offset, so they were never ours to
 * hold, and the alternative is a second listing pass to tell the two cases
 * apart for no behavioural difference.
 *
 * Callers must not pass an empty `keep` for a library that merely failed to
 * list — see the guard at the one call site in `engine/scan-worker.ts`.
 */
export function reapOrphanSidecars(keep: ReadonlySet<string>): string[] {
  const reaped: string[] = [];
  for (const id of listSidecarRecordIds()) {
    if (keep.has(id)) continue;
    deleteFaceSidecar(id);
    reaped.push(id);
  }
  return reaped;
}

/**
 * Every current sidecar, keyed by record id.
 *
 * Reads the whole store — a few hundred bytes per photo with no faces, ~1 KB per
 * face — which is what the People view and the label publisher both need, and
 * small enough that paging it would be more machinery than it saves.
 */
export function readAllFaceSidecars(): Map<string, FaceSidecar> {
  const out = new Map<string, FaceSidecar>();
  for (const id of listSidecarRecordIds()) {
    const sidecar = readFaceSidecar(id);
    if (sidecar && isCurrent(sidecar)) out.set(id, sidecar);
  }
  return out;
}
