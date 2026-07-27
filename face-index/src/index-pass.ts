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

export interface IndexResult {
  scanned: number;
  labelled: number;
  /** Images the detector found no faces in — deliberately left unlabelled. */
  skipped: number;
}

interface ListedRecord {
  id: string;
  type: string;
  labels?: Array<{ app_id: string; key: string; value: string | null }>;
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

export async function runIndexPass(fetchAs: Fetcher): Promise<IndexResult> {
  const result: IndexResult = { scanned: 0, labelled: 0, skipped: 0 };

  // Page to exhaustion. A short page does NOT mean the end — only a null
  // cursor does. Stopping on the first short page would silently skip images.
  let cursor: string | null = null;
  let batch: Array<{ recordId: string; key: string; value?: string | null }> = [];

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
      `/data/records?include=labels&limit=200${
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

      batch.push({ recordId: record.id, key: "faces-detected" });
      batch.push({ recordId: record.id, key: "face-count", value: String(faces) });
      result.labelled++;

      if (batch.length >= IMAGES_PER_BATCH * 2) await flush();
    }

    cursor = body.nextCursor;
  } while (cursor !== null);

  await flush();
  return result;
}
