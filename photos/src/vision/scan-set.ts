/**
 * Which records a scan looks at, and how it walks the library to find them.
 *
 * Split out of the worker because it is pure logic over listing rows and the
 * worker is not importable — that module pulls in `onnxruntime-node`, so a test
 * that reached for `isOriginal` would drag 270 MB of native runtime with it, and
 * would blur the one invariant `vision-bundle-isolation.test.ts` exists to
 * assert. Nothing here touches ONNX; the worker imports it.
 */

/** Records per listing page. A short page never means the end — see below. */
export const RECORDS_PER_PAGE = 200;

/** A row as `/data/records?include=labels` renders it. */
export interface ListedRecord {
  id: string;
  parent_id: string | null;
  /** One entry per `(app, key, value)`; a key may appear more than once. */
  labels?: Array<{ app_id: string; key: string; value?: string }>;
}

/**
 * The scan set: originals only.
 *
 * Thumbnails are excluded because they are downscaled re-encodings of images
 * already in the set; crops because a crop's faces are its parent's faces at an
 * offset.
 * Both would be work whose results duplicate an original's.
 *
 * Read off Photos' **own labels**, not `parent_id` — a crop has a parent too,
 * and `parentId !== null` meaning "is a thumbnail" is the exact bug
 * `photos-lib/labels.ts` was extracted to stop repeating. Scoped to the `photos`
 * namespace for the same reason: another app is free to declare a `rendition`
 * key meaning something else, and namespaces exist so that is not a collision.
 */
export function isOriginal(record: ListedRecord): boolean {
  if (record.parent_id !== null) return false;
  return !(record.labels ?? []).some(
    (l) => l.app_id === "photos" && (l.key === "rendition" || l.key === "crop"),
  );
}

/**
 * `fetch`-alike over the data server. Injected rather than built here so this
 * module owns no credential handling — and so a test can drive it.
 */
export type RecordFetcher = (path: string) => Promise<Response>;

/**
 * Every original in the library, paging to exhaustion.
 *
 * Two things this gets right that the obvious version does not:
 *
 * - **A short page is not the end.** Only an exhausted cursor is. The data
 *   server can return fewer rows than asked for — a label whose record was
 *   deleted drops out of the join — so stopping on a short page silently skips
 *   images and the scan quietly under-reports forever.
 * - **`?? null`.** A current data server sends `nextCursor: null` on the last
 *   page; one older than that contract omits the field entirely, and
 *   `undefined !== null` loops forever. An app is deployed independently of the
 *   data server it talks to, and the failure mode is a hang rather than an
 *   error, so this normalizes rather than assumes.
 */
export async function listOriginals(
  fetchRecords: RecordFetcher,
  pageSize: number = RECORDS_PER_PAGE,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const res = await fetchRecords(
      `/data/records?include=labels&limit=${pageSize}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    if (!res.ok) throw new Error(`list records failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      records: ListedRecord[];
      nextCursor?: string | null;
    };
    for (const record of body.records) {
      if (isOriginal(record)) ids.push(record.id);
    }
    cursor = body.nextCursor ?? null;
  } while (cursor !== null);
  return ids;
}
