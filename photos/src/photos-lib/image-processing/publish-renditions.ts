/**
 * Publishing derived renditions as shared child records.
 *
 * Shared by the Next `/api/resize` route and the cloud resize Lambda, which are
 * otherwise line-for-line copies of each other — the codebase's existing rule
 * is that anything kept in both eventually gets fixed in only one, and this is
 * a multi-step flow (presign → PUT → register → metadata) where a divergence
 * would be silent.
 *
 * ## Renditions are shared image records, not app-private data
 *
 * They are child records with `parent_id` set, exactly as thumbnails were,
 * because after originals are archived the renditions *are* the accessible form
 * of the library — so any image-granted app needs them. Two costs were accepted
 * for that: they outlive a Photos uninstall, and the label namespace stays
 * `photos/`.
 */

import { PHOTOS_APP_ID, PHOTOS_LABEL_KEYS } from "../labels";
import type { DerivedRendition } from "./derive-ladder";

/** Minimal view of the record a rendition is derived from. */
export interface RenditionParent {
  readonly id: string;
  readonly originalFilename: string | null;
}

/**
 * Something that can issue authenticated data-plane requests.
 *
 * Headers are a plain record rather than `HeadersInit`, matching what both
 * callers' `signedFetch` already accepts. Widening to `HeadersInit` here would
 * force every caller to handle the array and `Headers` forms it never receives.
 */
export interface SignedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type SignedFetch = (path: string, init?: SignedFetchInit) => Promise<Response>;

export interface PublishedRendition {
  readonly sizeClass: string;
  readonly recordId: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

export class RenditionPublishError extends Error {
  constructor(
    readonly stage: "presign" | "upload" | "register",
    readonly sizeClass: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Publishing ${sizeClass} failed at ${stage} (${status}): ${detail}`);
    this.name = "RenditionPublishError";
  }
}

/**
 * Publish one derived rendition: upload the bytes, register the record, write
 * its dimensions.
 *
 * Bytes go up via presigned PUT rather than inline, because the API Gateway
 * body cap is 7 MB and an `image-large` AVIF can approach it — but more
 * importantly because that is the path where the broker pins a checksum, so the
 * upload is verified rather than merely accepted.
 *
 * Dimensions are written because variant resolution orders renditions by long
 * edge. A rendition with no dimensions is invisible to resolution — it cannot
 * be ordered, so it is excluded — which would make it storage nobody ever
 * reads. Hence the metadata write is **not** best-effort here, unlike the
 * caption-style metadata elsewhere.
 */
export async function publishRendition(
  signedFetch: SignedFetch,
  parent: RenditionParent,
  rendition: DerivedRendition,
  contentHash: string,
  objectStorageKey: string,
): Promise<PublishedRendition> {
  const presignRes = await signedFetch(`/files/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: objectStorageKey,
      contentType: rendition.contentType,
      // Renditions are what the library is read from once originals are cold,
      // so every rung is `instant`. Only the original is ever `archive`.
      intent: "instant",
    }),
  });
  if (!presignRes.ok) {
    throw new RenditionPublishError(
      "presign",
      rendition.sizeClass,
      presignRes.status,
      await presignRes.text().catch(() => ""),
    );
  }
  const presign = (await presignRes.json()) as {
    url: string;
    checksumSha256?: string;
    storageClass?: string;
    tagging?: Record<string, string>;
  };

  const uploadRes = await fetch(presign.url, {
    method: "PUT",
    headers: {
      "Content-Type": rendition.contentType,
      // Mandatory when present — they are inside the signature, so dropping one
      // fails the request rather than uploading something unverified.
      ...(presign.checksumSha256 ? { "x-amz-checksum-sha256": presign.checksumSha256 } : {}),
      ...(presign.storageClass ? { "x-amz-storage-class": presign.storageClass } : {}),
      ...(presign.tagging && Object.keys(presign.tagging).length > 0
        ? {
            "x-amz-tagging": Object.entries(presign.tagging)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&"),
          }
        : {}),
    },
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

  const createRes = await signedFetch(`/data/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: rendition.type,
      fileName: renditionFileName(parent.originalFilename, rendition.sizeClass),
      contentType: rendition.contentType,
      contentHash,
      sizeBytes: rendition.data.byteLength,
      parentId: parent.id,
      // `parent_id` says *which* record this came from; the label says *how*,
      // which the column alone cannot express — without it a crop is
      // indistinguishable from a rendition. The `photos/` namespace comes from
      // the authenticated identity, so no prefix is sent.
      labels: [{ key: PHOTOS_LABEL_KEYS.rendition, value: rendition.sizeClass }],
    }),
  });
  if (!createRes.ok) {
    throw new RenditionPublishError(
      "register",
      rendition.sizeClass,
      createRes.status,
      await createRes.text().catch(() => ""),
    );
  }
  const { record } = (await createRes.json()) as { record: { id: string } };

  // Not best-effort: variant resolution orders by long edge, so a rendition
  // with no dimensions cannot be ordered and is excluded entirely — storage
  // nobody ever reads. A failure here is worth surfacing, though the rendition
  // itself already exists and a later metadata write repairs it.
  const metaRes = await signedFetch(`/data/records/${record.id}/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      typeId: "image",
      metadata: { width: rendition.width, height: rendition.height },
    }),
  });
  if (!metaRes.ok) {
    console.warn(
      `[renditions] dimensions write failed for ${rendition.sizeClass} of ${parent.id} ` +
        `(${metaRes.status}) — this rendition is invisible to variant resolution until repaired`,
    );
  }

  return {
    sizeClass: rendition.sizeClass,
    recordId: record.id,
    contentHash,
    sizeBytes: rendition.data.byteLength,
  };
}

function renditionFileName(originalFilename: string | null, sizeClass: string): string {
  const base = originalFilename ?? "image";
  return `${sizeClass}_${base}`;
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
    body: JSON.stringify({ typeId: "image", metadata: { thumb_hash: thumbHash } }),
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
 * before tagging. Neither side alone can freeze anything: an app that is wrong
 * about its ladder still cannot archive a small file, and a platform that
 * wanted to be clever still cannot archive a record whose renditions do not
 * exist.
 *
 * Tagging is not transitioning. The lifecycle rule performs the move after the
 * hold period, which is what buys a week to catch a derivation bug before the
 * input is behind a 48-hour thaw.
 *
 * Best-effort: a record that stays un-tagged simply stays in the instant tier,
 * costing a little more and behaving identically. Failing an ingest because an
 * optimisation did not apply would be the wrong trade.
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

/** The label ref a caller uses to ask the server which rungs a record has. */
export const RENDITION_LABEL_REF = `${PHOTOS_APP_ID}/${PHOTOS_LABEL_KEYS.rendition}`;

/**
 * Which rungs already exist for a record, read from the server.
 *
 * The `parentId` + `label` combination is one indexed lookup — this is the
 * query that makes "derivation state is a query, not a field" affordable, and
 * it is the same query the ladder-complete gate needs, so the two cannot
 * disagree.
 */
export async function existingRenditionClasses(
  signedFetch: SignedFetch,
  parentId: string,
): Promise<string[]> {
  const res = await signedFetch(
    `/data/records?parentId=${encodeURIComponent(parentId)}` +
      `&label=${RENDITION_LABEL_REF}&include=labels&limit=50`,
  );
  if (!res.ok) return [];
  const { records } = (await res.json()) as {
    records: Array<{ labels?: Array<{ app_id: string; key: string; value?: string }> }>;
  };
  const classes: string[] = [];
  for (const record of records) {
    for (const label of record.labels ?? []) {
      if (label.app_id === PHOTOS_APP_ID && label.key === PHOTOS_LABEL_KEYS.rendition) {
        if (label.value) classes.push(label.value);
      }
    }
  }
  return classes;
}
