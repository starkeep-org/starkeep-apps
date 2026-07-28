/**
 * One indexing pass: find images this app hasn't looked at, "detect" faces,
 * publish the results as cross-app labels.
 *
 * The point of this app is to be a *second* app — a distinct app id holding
 * only a `read` grant, labelling records Photos created. An equivalent module
 * inside Photos would be the origin app labelling its own records, which is
 * the degenerate case the old `records.label` column already covered and would
 * test none of what is new.
 */

import { signedFetch, type AppCredentials } from "@starkeep/app-client";
import { detectFaceCount } from "./detect.js";

export const APP_ID = "face-index";

/** DSQL caps a write transaction at 3,000 modified rows. Each image produces
 *  up to two labels, so 1,000 images per batch stays inside it with room. */
const IMAGES_PER_BATCH = 1_000;

/** Records per listing page. A short page never means the end — see below. */
const RECORDS_PER_PAGE = 200;

export interface IndexResult {
  scanned: number;
  labelled: number;
  /** Images the detector found no faces in — deliberately left unlabelled. */
  skipped: number;
}

interface ListedRecord {
  id: string;
  type: string;
  /** One entry per `(app, key, value)` — a key may appear more than once. */
  labels?: Array<{ app_id: string; key: string; value: string }>;
}

/**
 * `fetch`-alike bound to this app's credentials. Injected so tests can drive a
 * real local-data-server without this module owning credential loading.
 */
export type Fetcher = (
  path: string,
  init?: Parameters<typeof signedFetch>[2],
) => Promise<Response>;

export function fetcherFor(creds: AppCredentials): Fetcher {
  return (path, init) => signedFetch(creds, path, init);
}

/**
 * Sizes the pass's two loops. Both default to the production values; tests
 * shrink them so the paging and chunking paths are reachable without seeding
 * thousands of images, which is the only way those loops get exercised at all.
 */
export interface IndexPassOptions {
  /** Records requested per listing page. */
  pageSize?: number;
  /** Images accumulated before a label batch is flushed. */
  imagesPerBatch?: number;
}

export async function runIndexPass(
  fetchAs: Fetcher,
  options: IndexPassOptions = {},
): Promise<IndexResult> {
  const pageSize = options.pageSize ?? RECORDS_PER_PAGE;
  const imagesPerBatch = options.imagesPerBatch ?? IMAGES_PER_BATCH;
  const result: IndexResult = { scanned: 0, labelled: 0, skipped: 0 };

  // Page to exhaustion. A short page does NOT mean the end — only a null
  // cursor does. Stopping on the first short page would silently skip images.
  let cursor: string | null = null;
  let batch: Array<{ recordId: string; key: string; value?: string }> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const res = await fetchAs("/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: batch }),
    });
    if (!res.ok) {
      throw new Error(`label write failed: ${res.status} ${await res.text()}`);
    }
    batch = [];
  };

  do {
    const res = await fetchAs(
      `/data/records?include=labels&limit=${pageSize}${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`,
    );
    if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      records: ListedRecord[];
      nextCursor: string | null;
    };

    for (const record of body.records) {
      result.scanned++;

      // Already indexed. Cheap because the listing hydrated labels for us —
      // one query for the page rather than a lookup per record. Note this
      // reads OUR OWN namespace out of a set that includes every other app's
      // labels on the same record; there is no per-namespace read gate.
      const alreadySeen = record.labels?.some(
        (l) => l.app_id === APP_ID && (l.key === "faces-detected" || l.key === "face-count"),
      );
      if (alreadySeen) continue;

      const faces = detectFaceCount(record.id);
      if (faces === 0) {
        // No label at all, rather than a `faces-detected=false`. A presence
        // query has to mean "there are faces here"; publishing a negative
        // would make `?label=face-index/faces-detected` match everything.
        result.skipped++;
        continue;
      }

      // A plain add, not the set-valued write, and that is only correct because
      // of the `alreadySeen` guard above: `face-count` is single-valued, and an
      // add over an existing row would leave `face-count=3` beside
      // `face-count=4` rather than replacing it. Anything that re-indexes a
      // record it has already labelled — a detector change, a forced re-run —
      // must switch these to POST /data/labels/values.
      batch.push({ recordId: record.id, key: "faces-detected" });
      batch.push({ recordId: record.id, key: "face-count", value: String(faces) });
      result.labelled++;

      if (batch.length >= imagesPerBatch * 2) await flush();
    }

    cursor = body.nextCursor;
  } while (cursor !== null);

  await flush();
  return result;
}
