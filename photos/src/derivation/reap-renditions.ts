/**
 * Collecting rendition bytes nothing references.
 *
 * Two things produce them, and one pass answers both.
 *
 * **The loser of a concurrent publication.** Publication reads the
 * `(parent_record_id, size_class)` row, finds it absent, and writes. Two nodes
 * that read at the same time both write, and last-writer-wins over the HLC
 * picks one. The loser's bytes are already up under a key naming its own
 * content hash, with a live file row and nothing pointing at it. That is by
 * design: the alternative — a key built from parent and rung alone — would let
 * the two nodes overwrite each other's bytes under one name, which changes what
 * a published URL means under a reader holding it.
 *
 * **A rendition whose original is gone.** Deleting a photograph tombstones the
 * shared record. No cross-plane deletion hook exists, and inventing one would
 * put an app's private table in the path of a platform delete, so the rungs of
 * a deleted original are found the same way: their rows are deleted here, then
 * the bytes with them.
 *
 * ## Why a sweep rather than a subscription
 *
 * Both causes are races or cross-plane events that leave no signal to subscribe
 * to. A sweep also self-heals a third case nothing else would: a publication
 * that uploaded and registered and then failed before writing its row.
 *
 * ## The pass never deletes a blob it cannot explain
 *
 * A file row under `renditions/` whose sub-key no live rendition row names is
 * the whole test, and it is made against the table read *after* the file
 * listing. Reading the table second is the safe order: a rendition published
 * while the pass runs appears in the table and is kept, whereas reading the
 * table first would miss it and delete bytes a row had just started naming.
 */

import { parentOfRenditionSubKey, RENDITION_SUBKEY_PREFIX } from "../photos-lib/ladder";
import {
  deleteRenditionBlob,
  deleteRenditionRow,
  listRenditionBlobs,
  loadRenditionRows,
  loadLocalRenditions,
  type SignedFetch,
} from "../photos-lib/renditions/store";

export interface ReapResult {
  /** File rows under `renditions/` the pass looked at. */
  readonly examined: number;
  /** Blobs deleted because no rendition row named them. */
  readonly orphanedBlobs: number;
  /** Rows deleted because their original is gone. */
  readonly orphanedRows: number;
  /** Deletions that failed, which the next pass retries. */
  readonly failed: number;
}

/** How many parents one liveness query asks about. The grammar's `in` cap. */
const PARENTS_PER_QUERY = 500;

/**
 * Which of these record ids still exist on the shared plane.
 *
 * Asked as one `in` over the primary key per batch. A deleted record is
 * tombstoned rather than removed, and the server excludes tombstones from every
 * query, so absence from the answer is deletion.
 */
async function liveParents(
  signedFetch: SignedFetch,
  parentIds: readonly string[],
): Promise<Set<string>> {
  const live = new Set<string>();
  for (let i = 0; i < parentIds.length; i += PARENTS_PER_QUERY) {
    const chunk = parentIds.slice(i, i + PARENTS_PER_QUERY);
    const params = [
      `where=${encodeURIComponent(JSON.stringify({ id: { in: chunk } }))}`,
      `limit=${chunk.length}`,
      "select=id",
    ];
    const res = await signedFetch(`/data/records?${params.join("&")}`);
    if (!res.ok) {
      // A failed liveness check is not evidence of death. Treating the whole
      // chunk as live is the only safe reading: this pass deletes things.
      for (const id of chunk) live.add(id);
      continue;
    }
    const body = (await res.json()) as { records?: Array<{ id: string }> };
    for (const record of body.records ?? []) live.add(record.id);
  }
  return live;
}

/**
 * Run one reaping pass over Photos' private file plane.
 *
 * Ordered deliberately: list the blobs, then read the table, then delete the
 * rows of dead parents, then delete the blobs nothing names. Rows go first so
 * that a blob whose row this pass just deleted is collected by this pass rather
 * than the next one.
 */
export async function reapRenditions(signedFetch: SignedFetch): Promise<ReapResult> {
  const blobs = await listRenditionBlobs(signedFetch);
  const local = await loadLocalRenditions(signedFetch);
  for (const row of local) blobs.push({ subKey: row.sub_key, sizeBytes: row.size_bytes, resident: true });
  if (blobs.length === 0) {
    return { examined: 0, orphanedBlobs: 0, orphanedRows: 0, failed: 0 };
  }

  const parentIds = [
    ...new Set(
      blobs
        .map((blob) => parentOfRenditionSubKey(blob.subKey.replace(/^local\//, "")))
        .filter((id): id is string => id !== null),
    ),
  ];
  const rows = await loadRenditionRows(signedFetch, parentIds);
  const live = await liveParents(signedFetch, parentIds);

  let orphanedRows = 0;
  let failed = 0;
  const named = new Set<string>();
  const localWinners = new Map<string, string>();
  for (const row of local) {
    if (!live.has(row.parent_record_id)) continue;
    const identity = `${row.parent_record_id}:${row.size_class}`;
    localWinners.set(identity, row.sub_key);
  }
  for (const key of localWinners.values()) named.add(key);
  for (const [parentId, list] of rows) {
    const parentIsLive = live.has(parentId);
    for (const row of list) {
      if (parentIsLive) {
        named.add(row.sub_key);
        continue;
      }
      try {
        await deleteRenditionRow(signedFetch, parentId, row.size_class);
        orphanedRows += 1;
      } catch (err) {
        failed += 1;
        console.warn(
          `[reap] row ${parentId}/${row.size_class} could not be deleted:`,
          (err as Error).message,
        );
        // Keep the bytes: a row that is still there must keep pointing at
        // something.
        named.add(row.sub_key);
      }
    }
  }

  let orphanedBlobs = 0;
  for (const blob of blobs) {
    if (named.has(blob.subKey)) continue;
    try {
      await deleteRenditionBlob(signedFetch, blob.subKey);
      orphanedBlobs += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[reap] blob ${blob.subKey} could not be deleted:`, (err as Error).message);
    }
  }

  console.log(
    `[reap] prefix=${RENDITION_SUBKEY_PREFIX} examined=${blobs.length} ` +
      `blobs=${orphanedBlobs} rows=${orphanedRows} failed=${failed}`,
  );
  return { examined: blobs.length, orphanedBlobs, orphanedRows, failed };
}
