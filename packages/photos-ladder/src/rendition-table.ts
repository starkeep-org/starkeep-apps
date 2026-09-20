/**
 * Where a rendition lives now: Photos' own table and Photos' own file plane.
 *
 * A rung used to be a shared child record carrying a `photos/rendition` label,
 * which made every reader of the shared plane responsible for filtering out
 * five derived copies of every photograph — and Drive, which lists what the
 * user put in, did not. Renditions are app-private data by every test the
 * system applies: nothing but Photos reads them, they are re-derivable from the
 * original, and they are an implementation detail of one app's ladder.
 *
 * ## Why the shapes live here
 *
 * The desktop writes rows over HTTP, the cloud writes them over HTTP, and the
 * handset writes them straight into SQLite. Three writers and one table, so the
 * column names, the key scheme and the row shape have to be one declaration —
 * the same argument that put the ladder itself in this package. Nothing in this
 * file does I/O; it is the vocabulary each surface's own client speaks.
 *
 * ## The primary key is the identity
 *
 * `(parent_record_id, size_class)` — one row per rung per photograph, upserted.
 * The shared-record scheme dedeuped on `(parent_id, original_filename,
 * content_hash)` instead, so two encoders producing different bytes for one
 * rung minted two live children under one label, and every consumer had to
 * choose between them. Deriving a rung twice is now a write to the row that is
 * already there.
 */

import { renditionExtension } from "./ladder";
import type { DerivedChild } from "./rendition-resolution";

/** The app-syncable table, as declared in Photos' manifest. */
export const RENDITIONS_TABLE = "renditions";

/**
 * The sub-key prefix every rendition blob sits under.
 *
 * Load-bearing for the reaper, which finds orphaned bytes by walking the file
 * plane under this prefix and asking the table whether anything still names
 * each one. A second kind of app-private file under the same prefix would be
 * reaped.
 */
export const RENDITION_SUBKEY_PREFIX = "renditions/";

/** One rung of one photograph, as the table holds it. */
export interface RenditionRow {
  readonly parent_record_id: string;
  readonly size_class: string;
  /** The app-private file key holding the bytes. */
  readonly sub_key: string;
  readonly content_hash: string;
  readonly width: number;
  readonly height: number;
  readonly size_bytes: number;
  readonly content_type: string;
}

/**
 * Where one rung's bytes go.
 *
 * `renditions/<parent>/<size class>/<content hash>.<ext>`.
 *
 * The content hash stays in the key even though the row's primary key does not
 * mention it, and that is deliberate. A key built from `(parent, size_class)`
 * alone would let two nodes that derived the same rung write different bytes
 * under one name, which breaks every cache keyed on the URL and makes a
 * published URL change meaning under a reader. With the hash in the path, the
 * loser of a concurrent publication is an orphan — bytes nothing references —
 * which the reaper finds by joining the file plane against this table. An
 * orphan is recoverable; a silent byte swap is not.
 */
export function renditionSubKey(
  parentRecordId: string,
  sizeClass: string,
  contentHash: string,
  contentType: string,
): string {
  return (
    `${RENDITION_SUBKEY_PREFIX}${parentRecordId}/${sizeClass}/` +
    `${contentHash}.${renditionExtension(contentType)}`
  );
}

/** The parent a sub-key belongs to, or null when it is not a rendition key. */
export function parentOfRenditionSubKey(subKey: string): string | null {
  if (!subKey.startsWith(RENDITION_SUBKEY_PREFIX)) return null;
  const rest = subKey.slice(RENDITION_SUBKEY_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash <= 0 ? null : rest.slice(0, slash);
}

/**
 * A row as the resolver sees it.
 *
 * The content hash stands in for the record id the resolver used to sort by. It
 * is the same kind of value for the same purpose: derived from the bytes,
 * identical on every node, and therefore a tiebreak that paints the same rung
 * on every render rather than a different one per device.
 *
 * The sub-key would serve equally well as an identifier and is deliberately not
 * used, because this value reaches the browser: the sub-key names the rung, and
 * a rung's name is an implementation detail of Photos' ladder that no client
 * may see. Clients ask in pixels. `__tests__/no-size-class-in-consumers.test.ts`
 * is what keeps that true.
 */
export function renditionCandidate(row: RenditionRow, url?: string): DerivedChild {
  return {
    id: row.content_hash,
    longEdge: Math.max(row.width, row.height),
    width: row.width,
    height: row.height,
    type: row.content_type,
    ...(url ? { url } : {}),
  };
}
