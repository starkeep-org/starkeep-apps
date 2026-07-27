/**
 * Photos' own cross-app labels, and what it reads back out of them.
 *
 * `parent_id` says *which* record an image was derived from; these say *how*.
 * The column alone cannot express that, and reading `parentId !== null` as "is
 * a thumbnail" — which the grid and both resize paths used to do — mis-typed
 * every crop as its source's thumbnail.
 *
 * This lives in `photos-lib` because three callers need the same answers and
 * two of them are separate deployments: the Next `/api/resize` route, the
 * cloud resize Lambda, and the UI's record→AppImage mapping. Those two resize
 * paths are line-for-line copies of each other, so a rule that lived in both
 * would eventually only be fixed in one.
 */

import type { DerivedKind } from "./types/app-image";

/** Photos' app id — the namespace its own labels land in. */
export const PHOTOS_APP_ID = "photos";

/** The keys Photos declares in its manifest. Nothing else may be written. */
export const PHOTOS_LABEL_KEYS = {
  /** The child is a derived thumbnail of its parent. */
  thumbnailOf: "thumbnail-of",
  /** The child is a user-made crop of its parent. */
  cropOf: "crop-of",
} as const;

/** A record as the data servers render it with `?include=labels`. */
export interface LabelledRecord {
  labels?: Array<{ app_id: string; key: string }>;
}

/**
 * The parent-edge type, read off Photos' own labels.
 *
 * Scoped to `photos` deliberately: a hydrated list carries every app's labels,
 * and another app is free to declare a `crop-of` key meaning something else
 * entirely. Namespaces exist so that is not a collision.
 *
 * `null` covers two cases that behave the same everywhere they are used — an
 * original, and a derived image whose label has not arrived yet, since a record
 * and its labels share a request but not a transaction. Treating "not yet
 * labelled" as "not derived" is the safe direction: a placeholder for a moment
 * rather than a mis-typed edge.
 */
export function derivedKindOf(record: LabelledRecord): DerivedKind | null {
  for (const label of record.labels ?? []) {
    if (label.app_id !== PHOTOS_APP_ID) continue;
    if (label.key === PHOTOS_LABEL_KEYS.thumbnailOf) return "thumbnail";
    if (label.key === PHOTOS_LABEL_KEYS.cropOf) return "crop";
  }
  return null;
}

export function isThumbnail(record: LabelledRecord): boolean {
  return derivedKindOf(record) === "thumbnail";
}

/**
 * The thumbnail already generated for `targetId`, if there is one.
 *
 * Matching a thumbnail *specifically* rather than any child is the fix for a
 * real bug: with `parent_id` alone, cropping a photo made this return the crop,
 * and the photo silently never got a thumbnail.
 */
export function findThumbnailFor<T extends LabelledRecord & { id: string; parent_id: string | null }>(
  records: T[],
  targetId: string,
): T | undefined {
  return records.find((r) => r.parent_id === targetId && isThumbnail(r));
}

/**
 * May `targetId` be thumbnailed at all?
 *
 * A thumbnail may not — that would recurse. A *crop* may: it is a user artifact
 * that needs its own grid tile, and rejecting every record with a parent left
 * crops with no thumbnail and therefore invisible.
 */
export function canThumbnail<T extends LabelledRecord & { id: string }>(
  records: T[],
  targetId: string,
): boolean {
  const target = records.find((r) => r.id === targetId);
  return !target || !isThumbnail(target);
}
