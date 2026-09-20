import type { PhotosAppData } from "./app-data";
/** Resolve Photos-owned rendition rows against local byte availability. */

import type { DataRecord, MetadataRow, StarkeepId } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import {
  applicableStillClasses,
  renditionLongEdge,
  resolveRenditions,
  resolveWithoutDimensions,
  type DerivedChild,
  type RenditionChoice,
} from "@starkeep/photos-ladder";

/** Photos' app id — the namespace its own labels land in. */
export const PHOTOS_APP_ID = "photos";
/** Which label key names a rung of the ladder. */
export const PHOTOS_RENDITION_KEY = "rendition";


/**
 * What one record's tile or stage should do about renditions.
 *
 * Two answers rather than one, because "what to paint now" and "what to go and
 * get" are different questions with different answers, and collapsing them is
 * what produced the behaviour this replaces: the phone resolved which rung it
 * wanted, found the bytes absent, and silently painted the original instead —
 * never fetching the rung it had just decided it wanted.
 */
export interface ResolvedRendition {
  /** The resident file key identifies the rendition to paint. */
  readonly paint: { readonly id: StarkeepId; readonly objectStorageKey: string } | null;
  /** The missing ideal rendition’s app-private file key, or null. */
  readonly missingIdeal: StarkeepId | null;
}

/** The stored facts a record's resolution depends on. */
export interface RecordDimensions {
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * Per record: the rendition to paint now, and the one to fetch.
 *
 * ## Why the target is a function and not a number
 *
 * Because it is per record now. A justified row gives every photograph a box of
 * its own shape, so a portrait tile and a panorama in the same row want
 * different numbers of pixels — and the fixed square grid that made one number
 * right for a whole page is gone. See `render-target.ts`.
 *
 * ## Why the resolution runs twice
 *
 * `RenditionChoice.available` reports that the rendition **record** exists, not
 * that its bytes are on this device. On a browser those are the same thing: the
 * record carries a URL and fetching it is the browser's business. On a phone
 * they are not — metadata sync brings a rendition's row down long before, and
 * often without, its blob.
 *
 * So the same candidates are resolved twice:
 *
 *  - **over every known child**, which names the ideal rung's record — the thing
 *    to fetch;
 *  - **over the resident subset**, which names what to paint meanwhile.
 *
 * The second pass is correct rather than approximate, and that is a property of
 * `resolveRendition` rather than a trick: it computes the ideal from the
 * *applicable ladder* rather than from the candidate set it was handed, so
 * passing a subset yields exactly the same ideal marked unavailable, plus the
 * largest resident rung strictly below it. Filtering the candidates cannot
 * promote anything.
 *
 * ## The paint order, and there is no other
 *
 *  1. the ideal rung, when its bytes are resident;
 *  2. otherwise the largest resident rung **strictly below** the ideal;
 *  3. otherwise nothing from here — the caller paints the ThumbHash.
 *
 * A resident rung *above* the ideal is never chosen, and that is deliberate
 * rather than an oversight of the subset pass. `rendition-resolution.ts` sets
 * the rule out at length: reaching upward fetches the expensive thing first and
 * the correct thing second, and under Intelligent-Tiering it promotes exactly
 * the large objects tiering exists to make cheap. Here it would also cost the
 * decode the rendition was chosen to avoid.
 */
export async function resolveLibraryRenditions(
  database: DatabaseAdapter,
  records: readonly DataRecord[],
  options: {
    /** The pixel long edge this record's surface wants, or null to resolve nothing. */
    readonly photosData?: PhotosAppData;
    readonly viewer?: boolean;
    readonly targetFor: (record: DataRecord) => number | null;
    /** Whether these bytes are on this device. */
    readonly isResident: (objectStorageKey: string) => boolean;
    /**
     * The records' stored dimensions, read once by the caller.
     *
     * Passed in rather than read here because the caller needs the same rows for
     * the layout — a record's shape decides its box, and its box decides its
     * target. Reading them twice would be one extra query per page for numbers
     * the caller is holding.
     */
    readonly dimensionsOf: (record: DataRecord) => RecordDimensions | null;
  },
): Promise<Map<StarkeepId, ResolvedRendition>> {
  const out = new Map<StarkeepId, ResolvedRendition>();
  if (records.length === 0) return out;

  const candidatesByParent = options.photosData?.candidates(records.map(r => r.id)) ?? new Map();

  for (const record of records) {
    const target = options.targetFor(record);
    if (target === null) continue;

    const keyById = new Map<string, string>();
    const candidates: DerivedChild[] = [];
    const resident: DerivedChild[] = [];
    for (const c of candidatesByParent.get(record.id) ?? []) {
      // A candidate with no dimensions has no position on the ladder, so it
      // cannot answer a pixel request and is not one. A candidate with no key
      // names no bytes.
      if (!((c.width ?? 0) > 0 && (c.height ?? 0) > 0) || !c.objectStorageKey) continue;
      const child: DerivedChild = {
        id: c.id,
        longEdge: Math.max(c.width!, c.height!),
        width: c.width!,
        height: c.height!,
        type: c.type,
      };
      keyById.set(c.id, c.objectStorageKey);
      candidates.push(child);
      if (options.isResident(c.objectStorageKey)) resident.push(child);
    }

    const dims = options.dimensionsOf(record);
    const sourceLongEdge = Math.max(dims?.width ?? 0, dims?.height ?? 0);

    const known = resolveOne(target, sourceLongEdge, candidates);
    const here = resolveOne(target, sourceLongEdge, resident);

    // Rules 1 and 2 in one expression, because `resolveRendition` has already
    // applied them: over the resident subset the ideal is available exactly when
    // rule 1 holds, and the fallback is the largest resident rung below it
    // exactly when rule 2 does.
    const edges = sourceLongEdge > 0 ? applicableStillClasses(sourceLongEdge).map(spec => renditionLongEdge(spec, sourceLongEdge)) : [];
    const nextEdge = edges[edges.indexOf(known.ideal.longEdge) + 1];
    const oneUp = options.viewer && nextEdge !== undefined
      ? candidates.find(c => c.longEdge === nextEdge) : undefined;
    const largerChild = oneUp && resident.find(c => c.id === oneUp.id);
    const larger = largerChild ? { ...largerChild, available: true } : undefined;
    const painted = here.ideal.available ? here.ideal : larger ?? here.fallback;
    const paintId = painted?.available ? painted.id : undefined;
    const key = paintId ? keyById.get(paintId) : undefined;

    // Dimensionless originals resolve from the candidate set, so compare sizes
    // as well as availability before suppressing the ideal fetch.
    const idealIsHere =
      here.ideal.available && here.ideal.longEdge >= known.ideal.longEdge;
    // The ideal from the *known* pass, because that is the one that can name a
    // record the resident pass has never seen. An ideal with no id is a rung
    // nothing has derived yet, and there is nothing to fetch until something
    // does — the fetch this drives moves bytes, it does not commission work.
    const missingIdeal =
      idealIsHere || !known.ideal.available || !known.ideal.id
        ? null
        : (known.ideal.id as StarkeepId);

    out.set(record.id, {
      paint: paintId && key ? { id: paintId as StarkeepId, objectStorageKey: key } : null,
      missingIdeal,
    });
  }
  return out;
}

/**
 * One target against one candidate set.
 *
 * No stored dimensions means no applicable set, so there is no ideal to name.
 * Resolving among what exists and calling it final is the honest answer — and
 * this case shrinks on its own, because derivation writes the dimensions from
 * the decode it was doing anyway.
 */
function resolveOne(
  target: number,
  sourceLongEdge: number,
  candidates: readonly DerivedChild[],
): RenditionChoice {
  const resolved =
    sourceLongEdge > 0
      ? resolveRenditions([target], { sourceLongEdge, candidates })
      : resolveWithoutDimensions([target], candidates);
  return resolved[String(target)]!;
}

/**
 * The same answer for one record, for the surface that opens exactly one.
 *
 * The viewer's counterpart to the page call. It resolves a single record at a
 * single target — a bigger one, because a full screen is not a tile — and it
 * exists because the viewer used to request nothing at all and paint whatever
 * the grid had already chosen.
 */
export async function resolveRecordRenditions(
  database: DatabaseAdapter,
  record: DataRecord,
  target: number | null,
  isResident: (objectStorageKey: string) => boolean,
  dimensions: RecordDimensions | null,
  photosData?: PhotosAppData,
): Promise<ResolvedRendition | null> {
  if (target === null) return null;
  const resolved = await resolveLibraryRenditions(database, [record], {
    photosData,
    viewer: true,
    targetFor: () => target,
    isResident,
    dimensionsOf: () => dimensions,
  });
  return resolved.get(record.id) ?? null;
}

/**
 * The stored dimensions of a page of records, as {@link resolveLibraryRenditions}
 * wants them.
 *
 * Here rather than at the call site because the shape of a metadata row is the
 * caller's least interesting problem and getting it wrong is silent: a `width`
 * that arrives as a string resolves every record as dimensionless, which looks
 * exactly like a library that has not been backfilled.
 */
export function dimensionsFromMetadata(row: MetadataRow | undefined): RecordDimensions | null {
  if (!row) return null;
  const width = row["width"];
  const height = row["height"];
  return {
    width: typeof width === "number" && width > 0 ? width : null,
    height: typeof height === "number" && height > 0 ? height : null,
  };
}
