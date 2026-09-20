/**
 * Publishing derived renditions onto Photos' own plane.
 *
 * Shared by the local derivation worker, the on-demand resize route and the
 * cloud resize Lambda, which are otherwise line-for-line copies of each other —
 * the codebase's existing rule is that anything kept in both eventually gets
 * fixed in only one, and this is a multi-step flow (presign → PUT → register →
 * row) where a divergence would be silent.
 *
 * ## Renditions are app-private data, not shared records
 *
 * They used to be shared child records carrying a `photos/rendition` label,
 * and that cost more than it bought. Every consumer of shared image records had
 * to know the convention and filter on it, and Drive — which lists what the
 * user put in — did not, so a library of 60,000 photographs listed as 300,000
 * items. Nothing outside Photos ever read a rung, every rung is re-derivable
 * from the original, and which rungs exist is an implementation detail of one
 * app's ladder. So they moved to the plane that describes exactly that.
 *
 * What moved with them: the platform no longer evicts them (an app namespace is
 * skipped by the eviction pass), Photos is charged one advisory budget line for
 * all of them, and an uninstall that keeps the app's data keeps them.
 *
 * ## First writer wins
 *
 * A node reads the `(parent_record_id, size_class)` row before it uploads. A
 * live row means somebody already published this rung and this node keeps its
 * bytes to itself. The table's primary key is what makes the old
 * duplicate-minting loop unrepresentable: two encoders that disagree about the
 * bytes produce one row, not two children under one label.
 *
 * Two nodes that both read an absent row both write, and last-writer-wins over
 * the HLC picks one. The loser's bytes are a live file row nothing references,
 * which is what the reaper is for — see `derivation/reap-renditions.ts`.
 */

import { renditionFileName, renditionSubKey, type RenditionRow } from "../ladder";
import {
  loadRenditionsOf,
  putRenditionRow,
  type SignedFetch,
  type SignedFetchInit,
} from "../renditions/store";


export type { SignedFetch, SignedFetchInit };

/**
 * What a published rung is called.
 *
 * Re-exported rather than defined here since the phone began deriving too.
 * `@starkeep/photos-ladder` is where it lives, and this export is the name the
 * tests and call sites in this app already import.
 */
export { renditionFileName };

/** Minimal view of the record a rendition is derived from. */
export interface RenditionParent {
  readonly id: string;
  readonly originalFilename: string | null;
}

export interface PublishedRendition {
  readonly sizeClass: string;
  /** The app-private file key the bytes landed under. */
  readonly subKey: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  /**
   * True when another node had already published this rung and this one wrote
   * nothing. The rung exists either way, which is what the caller is asking.
   */
  readonly alreadyPublished: boolean;
}

export class RenditionPublishError extends Error {
  constructor(
    readonly stage: "presign" | "upload" | "register" | "row",
    readonly sizeClass: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Publishing ${sizeClass} failed at ${stage} (${status}): ${detail}`);
    this.name = "RenditionPublishError";
  }
}

/** What a rendition of any medium has to say about itself to be published. */
export interface PublishableRendition {
  readonly sizeClass: string;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Publish one derived rendition: claim the rung, upload the bytes, register the
 * file, write the row.
 *
 * Bytes go up via presigned PUT rather than inline, because the API Gateway
 * body cap is 7 MB and an `image-large` AVIF can approach it, and because the
 * platform never holds an app's private bytes on the write path.
 *
 * Dimensions are written because resolution orders rungs by long edge. A
 * rendition with no dimensions cannot be ordered and is therefore invisible —
 * storage nobody ever reads. They are columns of the row rather than a second
 * call, so the window in which a rung existed and its size did not is closed by
 * construction rather than by repair.
 */
export async function publishRendition(
  signedFetch: SignedFetch,
  parent: RenditionParent,
  rendition: PublishableRendition,
  contentHash: string,
  retainLocal = false,
): Promise<PublishedRendition> {
  // First-writer-wins, read at the top. A rung another node has already
  // published is not re-uploaded: object keys stop moving once a rung exists,
  // which is what lets a published URL keep its meaning.
  const existing = (await loadRenditionsOf(signedFetch, parent.id)).find(
    (row) => row.size_class === rendition.sizeClass,
  );
  if (existing && !retainLocal) {
    return {
      sizeClass: existing.size_class,
      subKey: existing.sub_key,
      contentHash: existing.content_hash,
      sizeBytes: Number(existing.size_bytes),
      alreadyPublished: true,
    };
  }

  const local = Boolean(existing && retainLocal);
  const subKey = (local ? "local/" : "") + renditionSubKey(
    parent.id,
    rendition.sizeClass,
    contentHash,
    rendition.contentType,
  );

  const row: RenditionRow = {
    parent_record_id: parent.id,
    size_class: rendition.sizeClass,
    sub_key: subKey,
    content_hash: contentHash,
    width: rendition.width,
    height: rendition.height,
    size_bytes: rendition.data.byteLength,
    content_type: rendition.contentType,
  };

  const presignRes = await signedFetch(`/app-data/files/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subKey, contentType: rendition.contentType }),
  });
  if (!presignRes.ok) {
    throw new RenditionPublishError(
      "presign",
      rendition.sizeClass,
      presignRes.status,
      await presignRes.text().catch(() => ""),
    );
  }
  const presign = (await presignRes.json()) as { url: string };

  const uploadRes = await fetch(presign.url, {
    method: "PUT",
    headers: { "Content-Type": rendition.contentType },
    // Copied into a fresh view: the DOM fetch types accept ArrayBufferView but
    // not the generic Uint8Array<ArrayBufferLike> that sharp's output widens to.
    body: new Uint8Array(rendition.data),
  });
  if (!uploadRes.ok) {
    throw new RenditionPublishError(
      "upload",
      rendition.sizeClass,
      uploadRes.status,
      uploadRes.statusText,
    );
  }

  // The index row, which is what makes the bytes visible to existence checks,
  // to cross-node sync and to this node's own byte accounting. The platform
  // never held the bytes, so this is the only point on the write path that
  // knows they are here.
  const registerRes = await signedFetch(`/app-data/files/${subKey}/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contentHash,
      ...(local ? { localMetadata: row } : {}),
      mimeType: rendition.contentType,
      sizeBytes: rendition.data.byteLength,
      originalFilename: renditionFileName(
        parent.originalFilename,
        rendition.sizeClass,
        rendition.contentType,
      ),
    }),
  });
  if (!registerRes.ok) {
    throw new RenditionPublishError(
      "register",
      rendition.sizeClass,
      registerRes.status,
      await registerRes.text().catch(() => ""),
    );
  }

  try {
    if (!local) await putRenditionRow(signedFetch, row);
  } catch (err) {
    // The bytes are up and the file row is written; only the rendition row is
    // missing, so the rung is an orphan the reaper will collect and the next
    // pass will derive it again. Reported as a publish failure rather than
    // swallowed, because a caller counting published rungs must not count this.
    throw new RenditionPublishError("row", rendition.sizeClass, 0, (err as Error).message);
  }

  return {
    sizeClass: rendition.sizeClass,
    subKey,
    contentHash,
    sizeBytes: rendition.data.byteLength,
    alreadyPublished: false,
  };
}

/**
 * Write the parent record's inline placeholder.
 *
 * Deliberately on the **parent**, not on a rendition. The placeholder exists so
 * a grid can paint a tile for a record before fetching anything — and the grid
 * lists originals, so a hash hanging off a child would be one join away from
 * the thing that needs it, which is exactly the round trip it exists to avoid.
 *
 * Best-effort: a missing placeholder costs a grey tile for a few hundred
 * milliseconds, which is a worse-looking version of what happened before rather
 * than a broken one.
 */
export async function publishThumbHash(
  signedFetch: SignedFetch,
  parentId: string,
  thumbHash: string,
): Promise<void> {
  const res = await signedFetch(`/data/records/${parentId}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      typeId: "image",
      metadata: { thumb_hash: thumbHash },
    }),
  });
  if (!res.ok) {
    console.warn(
      `[renditions] thumb_hash write failed for ${parentId} (${res.status}) — ` +
        `the grid will show a plain placeholder for this record`,
    );
  }
}

/**
 * Tell the platform this record's derived ladder is complete.
 *
 * The decision is deliberately split. Only Photos knows what a complete ladder
 * *is* — the platform must never learn what `image-medium` means, and a
 * platform-side check would have to. So the app asserts completeness, and the
 * platform independently applies its own floors (object size, cloud exclusion)
 * before tagging. Neither side alone can freeze anything.
 *
 * The claim now reads Photos' own table rather than a shared label, which is
 * the only source left: no rung is a shared record, so the platform can see
 * nothing about a ladder at all.
 *
 * Best-effort: a record that stays un-tagged simply stays in the instant tier,
 * costing a little more and behaving identically.
 */
export async function assertLadderComplete(
  signedFetch: SignedFetch,
  parentId: string,
): Promise<{ tagged: boolean; refusals: string[] }> {
  const res = await signedFetch(`/data/records/${parentId}/archive-gate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ladderComplete: true }),
  });
  if (!res.ok) {
    console.warn(`[renditions] archive gate for ${parentId} returned ${res.status}`);
    return { tagged: false, refusals: [`gate returned ${res.status}`] };
  }
  const body = (await res.json()) as { tagged?: boolean; refusals?: string[] };
  return { tagged: body.tagged === true, refusals: body.refusals ?? [] };
}

/**
 * Which rungs already exist for a record, read from Photos' own table.
 *
 * One indexed lookup on the primary key's leading column — the query that makes
 * "derivation state is a query, not a field" affordable, and the same query the
 * ladder-complete gate needs, so the two cannot disagree.
 *
 * `requireDimensions` is gone with the shared records: width and height are
 * `notNull` columns of the row, so a rung that exists has dimensions.
 */
export async function existingRenditionClasses(
  signedFetch: SignedFetch,
  parentId: string,
): Promise<string[]> {
  return (await loadRenditionsOf(signedFetch, parentId)).map((row) => row.size_class);
}
