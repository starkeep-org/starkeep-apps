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
 * `loadStandInsForPage` is the platform's, and it is the same query the two
 * data servers answer a listing's size summary from. It answers one
 * app-agnostic question — which stand-ins does each original have, and at what
 * fidelity — over the role and fidelity columns. It names no class, so it
 * belongs below this boundary rather than above it.
 */

import type { DataRecord, MetadataRow, StarkeepId } from "@starkeep/protocol-primitives";
import { loadStandInsForPage } from "@starkeep/storage-adapter";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";
import {
  resolveRenditions,
  resolveWithoutDimensions,
  stillTakesCanonical,
  type DerivedChild,
  type RenditionChoice,
} from "@starkeep/photos-ladder";

/** Photos' app id — the namespace its own labels land in. */
export const PHOTOS_APP_ID = "photos";

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
  /**
   * The rendition to paint, and where its bytes are.
   *
   * Non-null only when the bytes are **on this device**. The key rides along
   * because the caller needs a file, and asking the database for a child record
   * it already resolved would be a second query per page for a string this one
   * already had.
   */
  readonly paint: { readonly id: StarkeepId; readonly objectStorageKey: string } | null;
  /**
   * The ideal rung's record, when its bytes are not here.
   *
   * Null when the ideal is already resident, and null when the ladder names no
   * ideal at all — a record with no stored dimensions, or one whose rung was
   * never derived and so has no record to fetch. A caller reads this as "there
   * is something to fetch, and this is it".
   */
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

  // The page's stand-ins, by their columns — the platform's own loader, the
  // same query both data servers answer a listing's size summary from.
  const standInsByParent = await loadStandInsForPage(database, records);

  for (const record of records) {
    const target = options.targetFor(record);
    if (target === null) continue;

    const dims = options.dimensionsOf(record);
    const sourceLongEdge = Math.max(dims?.width ?? 0, dims?.height ?? 0);

    const keyById = new Map<string, string>();
    const candidates: DerivedChild[] = [];
    const resident: DerivedChild[] = [];
    const add = (id: string, longEdge: number, type: string, key: string) => {
      const child: DerivedChild = { id, longEdge, ...dimensionsAt(longEdge, dims), type };
      keyById.set(id, key);
      candidates.push(child);
      if (options.isResident(key)) resident.push(child);
    };
    for (const c of standInsByParent.get(record.id) ?? []) {
      // A stand-in's fidelity is its long edge. One with no key names no bytes.
      if (c.fidelity === null || !c.objectStorageKey) continue;
      add(c.id, c.fidelity, c.type, c.objectStorageKey);
    }
    // A self-canonical original stands in for itself above its largest
    // stand-in — `resolveRendition` names it as the ideal for a big enough
    // target — so it is a candidate at its own long edge.
    if (
      sourceLongEdge > 0 &&
      record.objectStorageKey &&
      !stillTakesCanonical(sourceLongEdge, record.sizeBytes)
    ) {
      add(record.id, sourceLongEdge, record.type, record.objectStorageKey);
    }

    const known = resolveOne(target, sourceLongEdge, candidates, record.sizeBytes);
    const here = resolveOne(target, sourceLongEdge, resident, record.sizeBytes);

    // Rules 1 and 2 in one expression, because `resolveRendition` has already
    // applied them: over the resident subset the ideal is available exactly when
    // rule 1 holds, and the fallback is the largest resident rung below it
    // exactly when rule 2 does.
    const painted = here.ideal.available ? here.ideal : here.fallback;
    const paintId = painted?.available ? painted.id : undefined;
    const key = paintId ? keyById.get(paintId) : undefined;

    // **The question is whether the ideal rung is here, not whether one
    // particular record is.** Two nodes encoding one class produce different
    // bytes — `avif-coder` against `sharp` — so a class can hold two records,
    // and a node holding the copy the tiebreak does not prefer holds the pixels
    // all the same. Testing residency of `known.ideal.id` would send this
    // device to the network for a rung it can already paint.
    //
    // Long edges compared rather than `here.ideal.available` alone. For a record
    // with stored dimensions the two are equivalent, because both passes compute
    // the ideal from the applicable ladder rather than from the candidates they
    // were handed. A record *without* them takes `resolveWithoutDimensions`,
    // which picks its ideal out of the candidate set — so the resident pass can
    // return a genuinely smaller rung marked available, and the comparison is
    // what keeps that fetch alive.
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
  sourceSizeBytes: number,
): RenditionChoice {
  const resolved =
    sourceLongEdge > 0
      ? resolveRenditions([target], { sourceLongEdge, sourceSizeBytes, candidates })
      : resolveWithoutDimensions([target], candidates);
  return resolved[String(target)]!;
}

/**
 * A stand-in's dimensions from its long edge and the original's aspect ratio.
 * A stand-in carries no metadata row — its fidelity is its size — and keeps
 * its original's shape.
 */
function dimensionsAt(longEdge: number, dims: RecordDimensions | null): { width: number; height: number } {
  const width = dims?.width ?? 0;
  const height = dims?.height ?? 0;
  if (width <= 0 || height <= 0) return { width: longEdge, height: longEdge };
  if (width >= height) return { width: longEdge, height: Math.max(1, Math.round((longEdge * height) / width)) };
  return { width: Math.max(1, Math.round((longEdge * width) / height)), height: longEdge };
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
): Promise<ResolvedRendition | null> {
  if (target === null) return null;
  const resolved = await resolveLibraryRenditions(database, [record], {
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
