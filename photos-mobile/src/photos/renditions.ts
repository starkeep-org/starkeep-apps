/**
 * Resolving a requested pixel size against Photos' ladder, on the phone.
 *
 * ## The boundary this file sits on
 *
 * On the laptop and in the cloud there are two processes with a signed HTTP hop
 * between them, so "the platform does not know what a size class is" enforces
 * itself. Here there is one process, so the same split has to hold as a
 * **module** boundary: `@starkeep/sync-engine`, the storage adapters and
 * `@starkeep/protocol-primitives` stay ladder-ignorant, and this — a
 * Photos-owned module *above* them — is where a class name may appear.
 *
 * Nothing but a convention enforces that, which is why
 * `__tests__/ladder-boundary.test.ts` exists.
 *
 * ## Why the ladder is imported rather than restated
 *
 * `@starkeep/photos-ladder` is the same package the web app and the cloud
 * Lambda consume. Two implementations of the resolution rule that disagree is a
 * rendering bug that appears on one device class only, which is close to the
 * worst kind to find — and a second copy of `STILL_LADDER` on the phone is
 * exactly how that happens.
 *
 * ## And why the *gathering* is not
 *
 * `loadVariantCandidatesForPage` is the platform's, and it is the same call the
 * two data servers make. It answers one app-agnostic question — what derived
 * children does this record have, and how big is each — over child records, a
 * label key and the width/height columns. It names no class, so it belongs
 * below this boundary rather than above it.
 */

import type { DataRecord, StarkeepId } from "@starkeep/protocol-primitives";
import {
  loadVariantCandidatesForPage,
  type DatabaseAdapter,
} from "@starkeep/storage-adapter";
import {
  resolveRenditions,
  resolveWithoutDimensions,
  type DerivedChild,
  type RenditionChoice,
} from "@starkeep/photos-ladder";

/** Photos' app id — the namespace its own labels land in. */
export const PHOTOS_APP_ID = "photos";
/** Which label key names a rung of the ladder. */
export const PHOTOS_RENDITION_KEY = "rendition";

const RENDITION_LABEL = { appId: PHOTOS_APP_ID, key: PHOTOS_RENDITION_KEY };

/**
 * Per record, per requested size: the rung it should have and what to show
 * meanwhile.
 *
 * The same two-entry answer the web and cloud surfaces get, produced by the
 * same rule. What differs is only how the candidates were gathered — a direct
 * adapter call here, a signed HTTP hop there.
 */
export async function resolveLibraryRenditions(
  database: DatabaseAdapter,
  records: readonly DataRecord[],
  targets: readonly number[],
): Promise<Map<StarkeepId, Record<string, RenditionChoice>>> {
  const out = new Map<StarkeepId, Record<string, RenditionChoice>>();
  if (records.length === 0 || targets.length === 0) return out;

  const candidatesByParent = await loadVariantCandidatesForPage(
    database,
    records,
    RENDITION_LABEL,
  );
  const dimensions = await database.getMetadataByIds(
    "image",
    records.map((r) => r.id),
  );

  for (const record of records) {
    const candidates: DerivedChild[] = (candidatesByParent.get(record.id) ?? [])
      .filter((c) => (c.width ?? 0) > 0 && (c.height ?? 0) > 0)
      .map((c) => ({
        id: c.id,
        longEdge: Math.max(c.width!, c.height!),
        width: c.width!,
        height: c.height!,
        type: c.type,
      }));

    const row = dimensions.get(record.id);
    const sourceLongEdge = Math.max(
      typeof row?.["width"] === "number" ? row["width"] : 0,
      typeof row?.["height"] === "number" ? row["height"] : 0,
    );

    // No stored dimensions means no applicable set, so there is no ideal to
    // name. Resolving among what exists and calling it final is the honest
    // answer — and this case shrinks on its own, because derivation writes the
    // dimensions from the decode it was doing anyway.
    out.set(
      record.id,
      sourceLongEdge > 0
        ? resolveRenditions(targets, { sourceLongEdge, candidates })
        : resolveWithoutDimensions(targets, candidates),
    );
  }
  return out;
}

/**
 * The id of the rendition a tile should paint for this record, or null to fall
 * back to the record's own bytes.
 *
 * Falling back is right on a phone in a way it is not in a browser: the bytes
 * are already on the device — this node imported them from its own camera roll
 * — so there is no download to avoid, only a decode. What the rendition buys
 * here is the decode, not the transfer.
 */
export function renditionToPaint(
  choice: RenditionChoice | undefined,
): { id: string } | null {
  if (!choice) return null;
  const entry = choice.ideal.available ? choice.ideal : choice.fallback;
  if (!entry?.available) return null;
  // `DerivedChild.id` is carried through resolution, so the caller can name the
  // record whose bytes it wants without this module knowing where they live.
  return entry.id ? { id: entry.id } : null;
}
