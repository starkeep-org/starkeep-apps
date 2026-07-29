/**
 * Publishing what the on-device scan found as cross-app labels.
 *
 * This is the one place vision state crosses onto the sync plane, and it is
 * deliberately narrow: **names and a count, never vectors or boxes.** It is also
 * off by default — making names queryable lets any app with an image read grant
 * enumerate the people in the library, which is why `publishLabels` is an
 * explicit opt-in (`starkeep-core/multi-value-labels.md`, "Privacy note").
 *
 * Two keys, because they mean different things:
 *
 * - **`photos/faces`** — one row per *named* person. It only exists once a human
 *   has named someone, so it means "has a named person", and matches nothing on
 *   a freshly scanned library.
 * - **`photos/face-count`** — written by the scan itself, so it covers every
 *   processed image with ≥1 face immediately. It is also the only one of the two
 *   with a usefully matchable value: a small integer compared by equality
 *   (`labelValue=1` → portraits) is what the platform means by "an enum, a
 *   count, a timestamp — never a sentence".
 *
 * Neither key is published for a zero-face image. A negative would make the
 * presence query `?label=photos/faces` match everything — the same reasoning the
 * `face-index` fixture records.
 */

import { readAllFaceSidecars } from "./sidecars";
import { readPeople } from "./people";
import { LABEL_VALUE_MAX_BYTES, LABEL_VALUES_PER_KEY_MAX, PHOTOS_LABEL_KEYS } from "@/photos-lib";

/**
 * DSQL caps a write transaction at 3,000 modified rows.
 *
 * Chunked on **rows, not images**: since `value` joined the label primary key,
 * rows-per-image is variable — a ten-person group photo is eleven rows — so a
 * per-image chunk size no longer bounds anything. 2,000 leaves room for the
 * tombstones the set-valued write emits alongside the upserts.
 */
export const MAX_ROWS_PER_BATCH = 2_000;

/** One `(record, key)` and the exact set of values it should hold. */
export interface LabelValueWrite {
  recordId: string;
  key: string;
  values: string[];
}

export interface PublishPlan {
  writes: LabelValueWrite[];
  /** Images with ≥1 face. */
  imagesWithFaces: number;
  /** Distinct names published across the library. */
  namesPublished: number;
}

/**
 * Build the full desired label state from the sidecar store.
 *
 * Every processed image gets an entry for both keys — including an *empty*
 * `values` for images with no faces, and for `faces` on images whose people are
 * all still unnamed. Empty is not a no-op: the set-valued write treats it as
 * "this key holds nothing", which is what retracts a name after an untagging or
 * a re-scan that no longer sees the face. Computing the whole desired state and
 * letting the server diff it is the only version of this that converges;
 * publishing only additions leaves stale rows forever.
 */
export function planLabelPublish(): PublishPlan {
  const namesById = new Map(readPeople().map((p) => [p.id, p.name.trim()]));
  const writes: LabelValueWrite[] = [];
  let imagesWithFaces = 0;
  const distinctNames = new Set<string>();

  for (const [recordId, sidecar] of readAllFaceSidecars()) {
    const count = sidecar.faces.length;
    if (count > 0) imagesWithFaces++;

    const names = new Set<string>();
    for (const face of sidecar.faces) {
      const name = face.personId ? namesById.get(face.personId) : undefined;
      // A name too long to store is dropped rather than truncated: a truncated
      // name is a *different* name that would match a query for neither the
      // real one nor anything else.
      if (name && Buffer.byteLength(name, "utf8") <= LABEL_VALUE_MAX_BYTES) names.add(name);
    }
    // The platform caps a key at 32 values per record and rejects the whole
    // batch over it, so a 40-person group photo would otherwise fail the entire
    // publish rather than just itself. Sorted-then-truncated so the subset is at
    // least stable across runs.
    const published = [...names].sort().slice(0, LABEL_VALUES_PER_KEY_MAX);
    for (const name of published) distinctNames.add(name);

    writes.push({ recordId, key: PHOTOS_LABEL_KEYS.faces, values: published });
    writes.push({
      recordId,
      key: PHOTOS_LABEL_KEYS.faceCount,
      values: count > 0 ? [String(count)] : [],
    });
  }

  return { writes, imagesWithFaces, namesPublished: distinctNames.size };
}

/**
 * Split writes into batches bounded by the rows each one modifies.
 *
 * A `values: []` entry still costs a row's worth of budget — it tombstones
 * whatever is there — so it is counted as one rather than zero, which keeps the
 * bound conservative in the direction that matters.
 */
export function chunkByRows(
  writes: readonly LabelValueWrite[],
  maxRows: number = MAX_ROWS_PER_BATCH,
): LabelValueWrite[][] {
  const batches: LabelValueWrite[][] = [];
  let current: LabelValueWrite[] = [];
  let rows = 0;

  for (const write of writes) {
    const cost = Math.max(1, write.values.length);
    if (current.length > 0 && rows + cost > maxRows) {
      batches.push(current);
      current = [];
      rows = 0;
    }
    current.push(write);
    rows += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export type LabelFetcher = (path: string, init: RequestInit) => Promise<Response>;

export interface PublishResult {
  imagesWithFaces: number;
  namesPublished: number;
  recordsWritten: number;
  batches: number;
}

/**
 * Push the plan to the data server.
 *
 * `POST /data/labels/values` — the **set-valued** write — rather than a plain
 * add, and that is not a preference. Since `value` joined the label primary key,
 * a plain add no longer overwrites: renaming Alice to Alicia with an add would
 * leave both rows on every photo, and there would be nothing to say which is
 * current. The set-valued write upserts and tombstones in one transaction, so a
 * rename or an untagging is atomic per `(record, key)`.
 */
export async function publishFaceLabels(fetchAs: LabelFetcher): Promise<PublishResult> {
  const plan = planLabelPublish();
  const batches = chunkByRows(plan.writes);

  for (const batch of batches) {
    const res = await fetchAs("/data/labels/values", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: batch }),
    });
    if (!res.ok) {
      throw new Error(`label publish failed: ${res.status} ${await res.text()}`);
    }
  }

  return {
    imagesWithFaces: plan.imagesWithFaces,
    namesPublished: plan.namesPublished,
    recordsWritten: plan.writes.length,
    batches: batches.length,
  };
}

/**
 * Retract everything this app published under both keys.
 *
 * Turning `publishLabels` off has to actually un-publish — leaving the rows
 * would make the toggle a lie about the disclosure it exists to control.
 */
export async function retractFaceLabels(fetchAs: LabelFetcher): Promise<PublishResult> {
  const writes: LabelValueWrite[] = [];
  for (const recordId of readAllFaceSidecars().keys()) {
    writes.push({ recordId, key: PHOTOS_LABEL_KEYS.faces, values: [] });
    writes.push({ recordId, key: PHOTOS_LABEL_KEYS.faceCount, values: [] });
  }
  const batches = chunkByRows(writes);
  for (const batch of batches) {
    const res = await fetchAs("/data/labels/values", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: batch }),
    });
    if (!res.ok) {
      throw new Error(`label retraction failed: ${res.status} ${await res.text()}`);
    }
  }
  return {
    imagesWithFaces: 0,
    namesPublished: 0,
    recordsWritten: writes.length,
    batches: batches.length,
  };
}
