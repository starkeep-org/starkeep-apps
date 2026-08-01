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
  /**
   * Which rung of the rendition ladder this child is — `image-medium`,
   * `video-720p`, and so on. See `ladder.ts` for the vocabulary.
   *
   * Replaces the old bare `thumbnail` flag, which could only express one
   * derived size. It is **single-valued**: a record is one rung, so it is
   * written through the set-valued endpoint (`POST /data/labels/values`), which
   * upserts the new value and tombstones the rest. A plain label write would
   * leave the old rung sitting beside the new one after a respec, with nothing
   * to say which is current.
   *
   * There is deliberately no `native` value. The original is not a rendition —
   * it is the thing renditions are derived *from* — and giving it a rung would
   * make "every applicable class is present" unsatisfiable and let variant
   * resolution serve an archived original.
   */
  rendition: "rendition",
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
  /**
   * This child is the motion half of its parent's Live Photo.
   *
   * A child rather than a merged record: the clip is real user data with its
   * own bytes, and merging would either discard it or invent a record type
   * whose halves live in different storage. Parent/child already says "these
   * belong together" and every consumer understands it.
   *
   * The value records *how* the pairing was decided — `identifier` when both
   * files carried Apple's shared content identifier, `filename` when it was
   * inferred from matching names. Kept because the two are not equally
   * trustworthy, and a user unpicking a wrong pairing deserves to know which
   * kind of evidence produced it.
   */
  livePhoto: "live-photo",
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
/**
 * The rung the current resize path produces.
 *
 * Named here rather than inlined because the resize path predates the ladder
 * and still generates exactly one size; when derivation generates the whole
 * ladder (item 7) this constant is what disappears, and everything referring to
 * it is the list of places that assumed one derived size.
 */
export const THUMBNAIL_SIZE_CLASS = "image-thumb";

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
  labels?: Array<{ app_id: string; key: string; value?: string }>;
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
    if (label.key === PHOTOS_LABEL_KEYS.rendition) return "thumbnail";
    if (label.key === PHOTOS_LABEL_KEYS.crop) return "crop";
  }
  return null;
}

/**
 * True when the record is any rung of the ladder.
 *
 * The name is now broader than it reads: with one derived size there was only
 * ever a thumbnail, and the questions callers ask ("may this be derived from?",
 * "should the grid show it?") are about derivedness rather than about a
 * particular size. Kept as-is so the two resize paths and the grid keep asking
 * the same question — {@link renditionClassOf} is what to use when the actual
 * rung matters.
 */
export function isThumbnail(record: LabelledRecord): boolean {
  return derivedKindOf(record) === "thumbnail";
}

/**
 * Which rung this record is, or null if it is not a rendition.
 *
 * Note this is deliberately not exposed to the UI: consumers request pixel
 * sizes and the server resolves. It exists for derivation and respec logic,
 * which genuinely does reason about classes.
 */
export function renditionClassOf(record: LabelledRecord): string | null {
  for (const label of record.labels ?? []) {
    if (label.app_id !== PHOTOS_APP_ID) continue;
    if (label.key === PHOTOS_LABEL_KEYS.rendition) return label.value ?? null;
  }
  return null;
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

/**
 * The two questions the resize paths must answer before deriving a thumbnail,
 * asked as two targeted queries instead of a scan of the library.
 *
 * Both used to be answered by listing `/data/records?limit=1000&include=labels`
 * and filtering client-side. That was O(library) to learn two bits — and worse,
 * it was *wrong* above the limit: on a library larger than the page, a record
 * outside the first 1000 read as "no thumbnail exists yet", so the same
 * thumbnail was derived over and over.
 *
 * `canThumbnail`/`findThumbnailFor` remain for callers that already hold a
 * hydrated page (the grid does) — they are the same rules over an in-memory
 * list. This is the same rules asked of the server.
 */
export interface ThumbnailPrecheck {
  /** The target is itself a thumbnail, so thumbnailing it would recurse. */
  readonly alreadyThumbnail: boolean;
  /** An existing thumbnail child of the target, if one has been derived. */
  readonly existingThumbnailId: string | null;
}

export async function precheckThumbnail(
  targetId: string,
  fetchPath: (path: string) => Promise<Response>,
): Promise<ThumbnailPrecheck> {
  // Q1: is the target itself a thumbnail? One record, its own labels.
  const selfRes = await fetchPath(
    `/data/records/${encodeURIComponent(targetId)}?include=labels`,
  );
  let alreadyThumbnail = false;
  if (selfRes.ok) {
    const { record } = (await selfRes.json()) as { record: LabelledRecord };
    alreadyThumbnail = isThumbnail(record);
  }

  // Q2: does a thumbnail child already exist? The label filter and the parent
  // filter combined — "a thumbnail *of this record*" — which is one indexed
  // lookup rather than a scan. A crop of the same parent does not match, which
  // is the bug `parent_id` alone used to have.
  const existingRes = await fetchPath(
    `/data/records?parentId=${encodeURIComponent(targetId)}` +
      `&label=${PHOTOS_APP_ID}/${PHOTOS_LABEL_KEYS.rendition}` +
      `&labelValue=${THUMBNAIL_SIZE_CLASS}&limit=1`,
  );
  let existingThumbnailId: string | null = null;
  if (existingRes.ok) {
    const { records } = (await existingRes.json()) as { records: Array<{ id: string }> };
    existingThumbnailId = records[0]?.id ?? null;
  }

  return { alreadyThumbnail, existingThumbnailId };
}
