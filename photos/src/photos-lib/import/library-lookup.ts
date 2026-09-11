/**
 * The library, asked one candidate at a time.
 *
 * ## What this replaces, and why
 *
 * The import loop used to fetch every record's fingerprints once per run and
 * compare each file against the whole array. On a 60k-item library that is one
 * page-through of `/data/records?include=metadata` — 300k+ records once the
 * rendition ladder is counted — held in memory for the length of the run, to
 * answer a question about one file at a time.
 *
 * `GET /data/metadata/image` addresses the per-category metadata table
 * directly, so tier 2 becomes an indexed equality lookup on the capture
 * fingerprint: one small query per candidate, seeking the
 * `(record_type, captured_at)` index rather than scanning anything. That is the
 * access path the metadata query route was built for.
 *
 * ## Tier 3 is not a predicate, and pretending otherwise would be worse
 *
 * Tier 3 asks "within six bits of this hash", and no filter grammar expresses a
 * Hamming distance. A 64-bit dHash has no prefix an index could seek for the
 * question — two images one bit apart can differ in the leading bit — so the
 * comparison has to happen over every stored hash whatever the transport.
 *
 * What the metadata route *does* buy is the size of that set. A projection of
 * `record_id, perceptual_hash` over the originals is two columns rather than a
 * hydrated record each, and it is fetched lazily and once per run: a run
 * importing only screenshots, none of which carries a perceptual hash, never
 * fetches it at all.
 *
 * ## Selecting the originals
 *
 * `{"perceptual_hash": {"ne": null}}` selects exactly the originals today,
 * because derivation writes `perceptual_hash` and `thumb_hash` onto the parent
 * record and writes `width` and `height` and nothing else onto each rendition.
 * That is a **derived coincidence, not a contract** — nothing stops a future
 * rung from carrying a hash — and it is relied on here only for tier 3, whose
 * answer degrades to a few extra comparisons if it ever stops holding. Tier 2
 * does not use it: pinning a non-null `captured_at` already excludes every
 * rendition, and excluding undervied originals would make the tier miss a file
 * whose EXIF has landed but whose ladder has not.
 */

import type { SignedFetch } from "../image-processing/publish-renditions";
import { captureFingerprint, type ImportCandidate, type LibraryEntry } from "./duplicate-tiers";

/** The per-category metadata query route, for the `image` category. */
const IMAGE_METADATA_PATH = "/data/metadata/image";

/**
 * The columns a finding needs.
 *
 * Projected explicitly rather than taking the table: a metadata row carries
 * seventeen columns and two tiers read six of them, and the rows in the
 * perceptual index are held for the length of a run.
 */
const FINGERPRINT_COLUMNS = [
  "record_id",
  "captured_at",
  "camera_make",
  "camera_model",
  "width",
  "height",
  "perceptual_hash",
] as const;

/**
 * The page size both queries ask for, which is the grammar's ceiling.
 *
 * For tier 2 it is a safety valve rather than a page: a capture fingerprint
 * matching 500 records means something has gone wrong with the fingerprint, and
 * the finding names the first match either way. For the perceptual index it is
 * the largest page the route will answer, so a library pages in the fewest
 * round trips available.
 */
const MAX_PAGE = 500;

/** Canonical ISO-8601 in UTC at millisecond precision — what a `timestamp` column takes. */
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** One row of `shared.record_image_metadata`, as the query route renders it. */
interface ImageMetadataRow {
  record_id?: unknown;
  captured_at?: unknown;
  camera_make?: unknown;
  camera_model?: unknown;
  width?: unknown;
  height?: unknown;
  perceptual_hash?: unknown;
}

/** Which records are worth comparing one incoming file against. */
export type LibraryLookup = (candidate: ImportCandidate) => Promise<LibraryEntry[]>;

/**
 * The tier-2 predicate for one candidate, or null when the candidate has no
 * capture fingerprint at all.
 *
 * Gated on {@link captureFingerprint} rather than on its own copy of the
 * preconditions. The two have to agree exactly: a query built from a weaker
 * precondition returns rows the comparison then rejects, and one built from a
 * stronger precondition silently answers nothing for files the tier covers.
 *
 * A null make or model is sent as `null`, which the grammar compiles to
 * `IS NULL`. Omitting the column instead would match every camera rather than
 * the absence of one, and "taken at this instant by no named camera" is a
 * different question from "taken at this instant".
 */
export function sameCaptureWhere(
  candidate: ImportCandidate,
): Record<string, unknown> | null {
  if (captureFingerprint(candidate) === null) return null;
  const capturedAt = candidate.capturedAt!;
  // The column is declared `timestamp`, and the grammar takes one spelling of
  // it. A non-canonical value would be a 400 rather than an empty answer, so it
  // is refused here — every writer in this app emits `toISOString()`, so this
  // fires only for a value that came from somewhere else.
  if (!CANONICAL_TIMESTAMP.test(capturedAt)) return null;
  return {
    captured_at: capturedAt,
    camera_make: candidate.cameraMake ?? null,
    camera_model: candidate.cameraModel ?? null,
    width: candidate.width,
    height: candidate.height,
  };
}

/**
 * A lookup bound to one data server, holding the perceptual index for the life
 * of one import run.
 *
 * The index is a promise assigned on first use, so concurrent candidates share
 * one fetch rather than racing to issue the same page-through. A run that never
 * meets a file with a perceptual hash never assigns it.
 */
export function createLibraryLookup(signedFetch: SignedFetch): LibraryLookup {
  let perceptualIndex: Promise<LibraryEntry[]> | null = null;

  return async (candidate) => {
    const sameCapture = await sameCaptureMatches(signedFetch, candidate);
    if (!candidate.perceptualHash) return sameCapture;

    const similar = await (perceptualIndex ??= loadPerceptualIndex(signedFetch));
    // Tier 2's rows first, because `findDuplicate` returns the strongest
    // finding it reaches and walks the array in order. Duplicates across the
    // two sets cost one extra comparison and change no answer.
    return [...sameCapture, ...similar];
  };
}

/** The records the camera says are the same exposure as this candidate. */
async function sameCaptureMatches(
  signedFetch: SignedFetch,
  candidate: ImportCandidate,
): Promise<LibraryEntry[]> {
  const where = sameCaptureWhere(candidate);
  if (!where) return [];
  const page = await queryImageMetadata(signedFetch, {
    where: JSON.stringify(where),
    select: FINGERPRINT_COLUMNS.join(","),
    limit: String(MAX_PAGE),
  });
  return page.rows;
}

/**
 * Every original's perceptual hash, paged through once.
 *
 * Failure is an empty index rather than an exception. The findings this feeds
 * are advisory — the file is already imported by the time they are computed —
 * so a lookup that cannot reach the server should cost the report rather than
 * the import.
 */
async function loadPerceptualIndex(signedFetch: SignedFetch): Promise<LibraryEntry[]> {
  const entries: LibraryEntry[] = [];
  let pageToken: string | null = null;
  try {
    do {
      const page: MetadataPage = await queryImageMetadata(signedFetch, {
        where: JSON.stringify({ perceptual_hash: { ne: null } }),
        select: "record_id,perceptual_hash",
        limit: String(MAX_PAGE),
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      entries.push(...page.rows);
      pageToken = page.pageToken;
    } while (pageToken);
  } catch (err) {
    console.warn(
      `[import] perceptual index unavailable (${(err as Error).message}) — ` +
        `similar-image findings will be missing from this run's report`,
    );
    return entries;
  }
  return entries;
}

interface MetadataPage {
  readonly rows: LibraryEntry[];
  readonly pageToken: string | null;
}

async function queryImageMetadata(
  signedFetch: SignedFetch,
  params: Record<string, string>,
): Promise<MetadataPage> {
  const res = await signedFetch(`${IMAGE_METADATA_PATH}?${new URLSearchParams(params)}`);
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  const body = (await res.json()) as { rows?: ImageMetadataRow[]; page_token?: string | null };
  return {
    rows: (body.rows ?? []).map(toLibraryEntry).filter((e): e is LibraryEntry => e !== null),
    // `?? null` rather than trusting the field: a short page is not the end of
    // a keyset walk, only an exhausted token is, and `undefined !== null` loops
    // forever.
    pageToken: body.page_token ?? null,
  };
}

/** One row as the tiers read it, or null for a row carrying no record id. */
function toLibraryEntry(row: ImageMetadataRow): LibraryEntry | null {
  const recordId = stringOrNull(row.record_id);
  if (!recordId) return null;
  return {
    recordId,
    capturedAt: stringOrNull(row.captured_at),
    cameraMake: stringOrNull(row.camera_make),
    cameraModel: stringOrNull(row.camera_model),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    perceptualHash: stringOrNull(row.perceptual_hash),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
