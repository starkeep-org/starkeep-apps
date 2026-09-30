/**
 * Publishing derived renditions as shared child records.
 *
 * Shared by the Next `/api/resize` route and the cloud resize Lambda, which are
 * otherwise line-for-line copies of each other — the codebase's existing rule
 * is that anything kept in both eventually gets fixed in only one, and this is
 * a multi-step flow (presign → PUT → register) where a divergence
 * would be silent.
 *
 * ## Renditions are platform stand-ins
 *
 * Each rung is a shared record whose `parent_id` names the original and whose
 * `standIn` says what it is — the canonical stand-in or a smaller one, at a
 * standard size. After originals are archived the stand-ins *are* the
 * accessible form of the library, so any image-granted app reads them, and the
 * platform itself reads the canonical one to decide when the original may
 * archive. They carry no Photos label: the role and fidelity columns say what
 * they are to every app.
 */

import { PHOTOS_APP_ID, PHOTOS_LABEL_KEYS } from "../labels";
import { classForStandIn, renditionFileName, standInFieldsFor, type SizeClass } from "../ladder";
import type { DerivedRendition } from "./derive-ladder";

/**
 * What a published rung is called.
 *
 * Re-exported rather than defined here since the phone began deriving too. The
 * name is part of a record's content-addressed id, so it has to be one rule
 * shared by every node that publishes a rung; `@starkeep/photos-ladder` is where
 * it now lives, and this export is the name the tests and call sites in this app
 * already import.
 */
export { renditionFileName };

/** Minimal view of the record a rendition is derived from. */
export interface RenditionParent {
  readonly id: string;
  readonly originalFilename: string | null;
  /**
   * The original's fidelity as the decode or probe measured it: the long edge
   * for a still, the whole-container bitrate in kbps for a video. Reported to
   * the platform with every stand-in, which records it once — so whichever
   * rung lands first carries it.
   */
  readonly sourceFidelity?: number | null;
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
  /**
   * True when the platform already held a stand-in in this slot — made by
   * another node or another app — and this one was not registered. The rung
   * exists either way, which is all a caller needs.
   */
  readonly reused?: boolean;
}

export class RenditionPublishError extends Error {
  constructor(
    readonly stage: "presign" | "upload" | "register" | "metadata",
    readonly sizeClass: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Publishing ${sizeClass} failed at ${stage} (${status}): ${detail}`);
    this.name = "RenditionPublishError";
  }
}

/**
 * Publish one derived rendition: upload the bytes, then register the stand-in.
 *
 * Bytes go up via presigned PUT rather than inline, because the API Gateway
 * body cap is 7 MB and an `image-large` AVIF can approach it — but more
 * importantly because that is the path where the broker pins a checksum, so the
 * upload is verified rather than merely accepted.
 *
 * No dimensions ride the create any more. Resolution orders stand-ins by their
 * fidelity, a column the create itself writes, so there is no window in which
 * a stand-in exists without the one fact that makes it usable — the window a
 * separate metadata write used to leave open. The platform refuses metadata on
 * a stand-in for the same reason: the original's row describes the item.
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

  return registerStandIn(signedFetch, parent, {
    sizeClass: rendition.sizeClass,
    type: rendition.type,
    contentType: rendition.contentType,
    fileName: renditionFileName(parent.originalFilename, rendition.sizeClass),
    contentHash,
    sizeBytes: rendition.data.byteLength,
  });
}

/**
 * Register an uploaded rung as a stand-in of its original.
 *
 * The request says what the rung is — `standIn: { role, fidelity }` — and
 * reports the original's fidelity alongside, which the platform records the
 * first time. Two answers mean the work is already done and are successes
 * here:
 *
 * - **A dedup** — this node registered these exact bytes before.
 * - **`StandInExists`** — another node or another app holds the slot. Its
 *   stand-in meets the same standard, so Photos reuses it rather than making a
 *   second: the platform keeps one per size per original.
 *
 * One answer is retried: a disagreement about the original's fidelity. The
 * platform's record is authoritative, and the rung is still wanted, so the
 * second attempt reports nothing and lets the platform check against what it
 * holds.
 */
export async function registerStandIn(
  signedFetch: SignedFetch,
  parent: RenditionParent,
  upload: {
    readonly sizeClass: SizeClass;
    readonly type: string;
    readonly contentType: string;
    readonly fileName: string;
    readonly contentHash: string;
    readonly sizeBytes: number;
  },
): Promise<PublishedRendition> {
  const standIn = standInFieldsFor(upload.sizeClass, parent.sourceFidelity ?? null);
  if (!standIn) {
    throw new RenditionPublishError("register", upload.sizeClass, 0, "not a stand-in rung");
  }
  const attempt = (reportFidelity: boolean) =>
    signedFetch(`/data/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: upload.type,
        fileName: upload.fileName,
        contentType: upload.contentType,
        contentHash: upload.contentHash,
        sizeBytes: upload.sizeBytes,
        parentId: parent.id,
        standIn,
        ...(reportFidelity && parent.sourceFidelity ? { parentFidelity: parent.sourceFidelity } : {}),
      }),
    });

  let createRes = await attempt(true);
  if (createRes.status === 409) {
    const conflict = (await createRes.clone().json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      existing?: string;
    };
    if (conflict.error === "StandInExists" && conflict.existing) {
      return {
        sizeClass: upload.sizeClass,
        recordId: conflict.existing,
        contentHash: upload.contentHash,
        sizeBytes: upload.sizeBytes,
        reused: true,
      };
    }
    if (conflict.code === "parent-fidelity-mismatch") createRes = await attempt(false);
  }
  if (!createRes.ok) {
    throw new RenditionPublishError(
      "register",
      upload.sizeClass,
      createRes.status,
      await createRes.text().catch(() => ""),
    );
  }
  const { record } = (await createRes.json()) as { record: { id: string } };
  return {
    sizeClass: upload.sizeClass,
    recordId: record.id,
    contentHash: upload.contentHash,
    sizeBytes: upload.sizeBytes,
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
  // This used to write `perceptual_hash` alongside, computed from the same
  // decode. Nothing reads that column any more: near-duplicate detection was
  // removed on 2026-09-11, and a derived fact with no reader is work every
  // derivation pays for nobody. The column stays declared in the registry, and
  // whether to retire it is a separate decision — see
  // `photos-cleanup-2026-09-11.md`.
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
 * Tell the platform an original's fidelity — a still's long edge, a video's
 * bitrate in kbps — measured from a decode or probe Photos was doing anyway.
 *
 * Every stand-in reports it too, so this matters for the original that takes
 * none: one too small for any standard size. Without a reported fidelity the
 * platform cannot tell such an original stands in for itself, and no node
 * receives it by default. The platform records the value once; a repeat is a
 * no-op. Best-effort: a failure leaves the value for the next decode.
 */
export async function reportOriginalFidelity(
  signedFetch: SignedFetch,
  recordId: string,
  fidelity: number | null,
): Promise<void> {
  if (fidelity === null || !(fidelity > 0)) return;
  const res = await signedFetch(`/data/records/${recordId}/fidelity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fidelity }),
  });
  if (!res.ok && res.status !== 409) {
    console.warn(`[renditions] fidelity report for ${recordId} failed (${res.status})`);
  }
}

/**
 * The label ref for Photos' derived records — poster frames and skims — which
 * are not stand-ins and so carry no role for the platform to report. Listings
 * ask for these as `variant` candidates; see `stand-in-candidates.ts`.
 */
export const DERIVED_LABEL_REF = `${PHOTOS_APP_ID}/${PHOTOS_LABEL_KEYS.derived}`;

/**
 * Which rungs already exist for a record, read from the server.
 *
 * Stand-ins by their columns — one indexed lookup on parent and role, with no
 * label to wait for — and derived records by Photos' own label. A stand-in at
 * a size this ladder does not name, which another app may have made, is not a
 * rung of Photos' ladder and is left out.
 */
export async function existingRenditionClasses(
  signedFetch: SignedFetch,
  parentId: string,
): Promise<SizeClass[]> {
  const classes: SizeClass[] = [];
  const standInsRes = await signedFetch(
    `/data/records?where=${encodeURIComponent(
      JSON.stringify({ parent_id: parentId, stand_in_role: { in: ["canonical", "smaller"] } }),
    )}&limit=50`,
  );
  if (standInsRes.ok) {
    const { records } = (await standInsRes.json()) as {
      records: Array<{ type: string; stand_in_role: "canonical" | "smaller"; fidelity: number }>;
    };
    for (const record of records) {
      const category = record.type.startsWith("video/") ? "video" : "image";
      const sizeClass = classForStandIn(category, record.stand_in_role, record.fidelity);
      if (sizeClass) classes.push(sizeClass);
    }
  }
  const derivedRes = await signedFetch(
    `/data/records?where=${encodeURIComponent(JSON.stringify({ parent_id: parentId }))}` +
      `&label=${DERIVED_LABEL_REF}&include=labels&limit=50`,
  );
  if (derivedRes.ok) {
    const { records } = (await derivedRes.json()) as {
      records: Array<{ labels?: Array<{ app_id: string; key: string; value?: string }> }>;
    };
    for (const record of records) {
      for (const label of record.labels ?? []) {
        if (label.app_id === PHOTOS_APP_ID && label.key === PHOTOS_LABEL_KEYS.derived && label.value) {
          classes.push(label.value as SizeClass);
        }
      }
    }
  }
  return classes;
}
