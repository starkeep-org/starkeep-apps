/**
 * Reading the user's confirmed tags out of `image_enriched`, for the publisher.
 *
 * Separate from `tags.ts` because it is the one part of the tag story that makes a
 * *network* call: the edits live in a syncable app table reached over the data
 * server, while everything else `tags.ts` does is arithmetic over local sidecars.
 * Keeping the fetch here leaves `planLabelPublish` a pure function of its inputs.
 *
 * **Only `added` is publishable** (§7). That field is exactly "tags a human typed or
 * explicitly kept" — a suggestion the user never touched is not in it, and a
 * suggestion they removed is in `removed` instead. So the publishable set falls out
 * of the diff's shape without needing to re-score anything, which also means
 * publishing does not depend on the vocabulary, the tag embeddings, or the scene
 * model being current.
 */

import { parseTagEdits } from "./tags";

export type LabelFetcher = (path: string, init?: RequestInit) => Promise<Response>;

/** How many rows to ask for per page. The platform caps this; 500 matches the grid. */
const PAGE = 500;

/**
 * `recordId → confirmed tags`, for every row that has any edits at all.
 *
 * Rows whose confirmed set is *empty* are included deliberately — a photo whose last
 * tag the user just deleted needs an explicit empty write to retract what was
 * published, and omitting it would leave the old rows on the shared plane forever.
 * Rows with no `tag_edits` at all are omitted, since there is nothing to retract.
 */
export async function readConfirmedTags(
  fetchAs: LabelFetcher,
): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  let offset = 0;

  for (;;) {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    const res = await fetchAs(`/app-data/db/image_enriched?${q.toString()}`);
    if (!res.ok) {
      // The publisher's caller reports this as a warning and keeps the setting; an
      // unreadable table is not a reason to fail the whole publish of face labels,
      // which do not depend on it.
      throw new Error(`could not read image_enriched: ${res.status}`);
    }
    const { rows } = (await res.json()) as {
      rows?: Array<{ record_id?: unknown; tag_edits?: unknown }>;
    };
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      if (typeof row.record_id !== "string") continue;
      // No edits column means the user has never touched this photo's tags, so
      // there is nothing to publish and nothing to retract.
      if (row.tag_edits === null || row.tag_edits === undefined) continue;
      out.set(row.record_id, parseTagEdits(row.tag_edits).added);
    }

    if (rows.length < PAGE) break;
    offset += rows.length;
  }

  return out;
}
