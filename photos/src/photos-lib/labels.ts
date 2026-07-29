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

/**
 * The keys Photos declares in its manifest. Nothing else may be written.
 *
 * `thumbnail` and `crop` are **bare flags** — written once, at record creation,
 * with no value, which is stored as the empty string. That is why a plain label
 * write is right for them: a key is set-valued and a plain write adds rather
 * than replaces, so a key Photos ever *updated* would need the set-valued write
 * (`POST /data/labels/values`) instead, or the old value would sit beside the
 * new one with nothing to say which is current.
 *
 * `faces` and `face-count` are exactly that updated case, and both go through
 * `/data/labels/values` — see `src/vision/label-publish.ts`.
 */
export const PHOTOS_LABEL_KEYS = {
  /** The child is a derived thumbnail of its parent. */
  thumbnail: "thumbnail",
  /** The child is a user-made crop of its parent. */
  crop: "crop",
  /**
   * One value per *named* person in the photo. Multi-valued, which is what the
   * widened label primary key exists for — `?label=photos/faces&labelValue=Alice`
   * is the query this key is published to answer.
   *
   * Only written when the user opts in (`publishLabels`), and only for people
   * they have named: an unnamed cluster has nothing to say to another app.
   */
  faces: "faces",
  /**
   * How many faces the on-device scan found. Single-valued, and a small integer
   * matched by equality — `labelValue=1` finds portraits.
   *
   * Absent, never zero, on an image with no faces: publishing a negative would
   * make the presence query match every processed image.
   */
  faceCount: "face-count",
} as const;

/**
 * Platform caps on a label value, mirrored from
 * `@starkeep/protocol-primitives/records/labels`.
 *
 * Copied rather than imported because Photos depends only on
 * `@starkeep/app-client`, and a data-plane package would be a much larger
 * dependency for two numbers. They bound what the publisher may send; the data
 * server enforces them for real, and a write that exceeds either is rejected as
 * a whole batch.
 */
export const LABEL_VALUE_MAX_BYTES = 128;
export const LABEL_VALUES_PER_KEY_MAX = 32;

/**
 * A record as the data servers render it with `?include=labels`.
 *
 * One entry per `(app, key, value)`: a key is set-valued, so the same
 * `app_id`/`key` may appear more than once with different values. Photos' own
 * keys are flags and so appear at most once each, but the array as a whole
 * carries every app's labels and must not be read as a key→label map.
 */
export interface LabelledRecord {
  labels?: Array<{ app_id: string; key: string }>;
}

/**
 * The parent-edge type, read off Photos' own labels.
 *
 * Scoped to `photos` deliberately: a hydrated list carries every app's labels,
 * and another app is free to declare a `crop` key meaning something else
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
    if (label.key === PHOTOS_LABEL_KEYS.thumbnail) return "thumbnail";
    if (label.key === PHOTOS_LABEL_KEYS.crop) return "crop";
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
