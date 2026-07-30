/**
 * Publishing what the on-device scan found as cross-app labels.
 *
 * This is the one place vision state crosses onto the sync plane, and it is
 * deliberately narrow: **names and a count, never vectors or boxes.** It is also
 * off by default — making names queryable lets any app with an image read grant
 * enumerate the people in the library, which is why `publishLabels` is an
 * explicit opt-in (`starkeep-core/multi-value-labels.md`, "Privacy note").
 *
 * Three keys, because they mean different things:
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
 * - **`photos/tags`** — one row per tag the user has **confirmed or typed** (§7).
 *   Never a machine suggestion: a suggestion is an uncalibrated cosine that moved
 *   the last time the vocabulary changed, and publishing it would make that number
 *   another app's ground truth. Same precedent as `faces`, where only *named*
 *   clusters cross the plane and never raw detections.
 *
 * Neither face key is published for a zero-face image. A negative would make the
 * presence query `?label=photos/faces` match every processed image, so absence
 * is how "no faces" is encoded.
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
  /** Distinct user-confirmed tags published across the library. */
  tagsPublished: number;
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
/**
 * One record's user-authored tags, as the publisher needs them.
 *
 * Passed in rather than read here, because they live in `image_enriched` — a
 * *syncable* table reached over the network — while everything else this module
 * folds is local sidecars. Keeping the fetch outside makes the plan a pure function
 * of its inputs, which is what lets the tests cover the set arithmetic without a
 * data server.
 */
export type ConfirmedTagsByRecord = ReadonlyMap<string, readonly string[]>;

export function planLabelPublish(
  confirmedTags: ConfirmedTagsByRecord = new Map(),
): PublishPlan {
  const namesById = new Map(readPeople().map((p) => [p.id, p.name.trim()]));
  const writes: LabelValueWrite[] = [];
  let imagesWithFaces = 0;
  const distinctNames = new Set<string>();
  const distinctTags = new Set<string>();

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

  // Tags are keyed on their own record set, not on the face store's. A photo can
  // carry user tags without ever having been face-scanned, and iterating the face
  // sidecars would silently drop exactly those.
  for (const [recordId, tags] of tagRecords(confirmedTags)) {
    const published = boundedValues(tags);
    for (const tag of published) distinctTags.add(tag);
    writes.push({ recordId, key: PHOTOS_LABEL_KEYS.tags, values: published });
  }

  return {
    writes,
    imagesWithFaces,
    namesPublished: distinctNames.size,
    tagsPublished: distinctTags.size,
  };
}

/**
 * Every record that needs a `tags` write — including ones whose tags are now empty.
 *
 * An empty set is not a no-op: the set-valued write reads it as "this key holds
 * nothing", which is what retracts a tag the user has just deleted. Dropping empty
 * entries would leave the old rows published forever, so a record present in the
 * input with no confirmed tags still gets an explicit empty write.
 */
function tagRecords(confirmedTags: ConfirmedTagsByRecord): Map<string, readonly string[]> {
  return new Map(confirmedTags);
}

/**
 * The same value bounds the face path applies, for the same reasons.
 *
 * Over-long values are dropped rather than truncated — a truncated tag is a
 * *different* tag that matches a query for neither — and the per-key cap is applied
 * after sorting so the surviving subset is stable across runs rather than depending
 * on iteration order.
 */
function boundedValues(values: readonly string[]): string[] {
  const kept = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (Buffer.byteLength(trimmed, "utf8") > LABEL_VALUE_MAX_BYTES) continue;
    kept.add(trimmed);
  }
  return [...kept].sort().slice(0, LABEL_VALUES_PER_KEY_MAX);
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

export type LabelFetcher = (path: string, init?: RequestInit) => Promise<Response>;

export interface PublishResult {
  imagesWithFaces: number;
  namesPublished: number;
  tagsPublished: number;
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
export async function publishFaceLabels(
  fetchAs: LabelFetcher,
  confirmedTags: ConfirmedTagsByRecord = new Map(),
): Promise<PublishResult> {
  const plan = planLabelPublish(confirmedTags);
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
    tagsPublished: plan.tagsPublished,
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
export async function retractFaceLabels(
  fetchAs: LabelFetcher,
  taggedRecordIds: readonly string[] = [],
): Promise<PublishResult> {
  const writes: LabelValueWrite[] = [];
  for (const recordId of readAllFaceSidecars().keys()) {
    writes.push({ recordId, key: PHOTOS_LABEL_KEYS.faces, values: [] });
    writes.push({ recordId, key: PHOTOS_LABEL_KEYS.faceCount, values: [] });
  }
  // Tagged records are retracted from their own set for the same reason they were
  // published from it: a photo may carry tags and no face sidecar, and a retraction
  // that missed those would leave the toggle a lie about what it un-published.
  for (const recordId of new Set(taggedRecordIds)) {
    writes.push({ recordId, key: PHOTOS_LABEL_KEYS.tags, values: [] });
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
    tagsPublished: 0,
    recordsWritten: writes.length,
    batches: batches.length,
  };
}
