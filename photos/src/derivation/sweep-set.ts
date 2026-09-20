/**
 * What the sweep looks at, and how it decides a record needs work.
 *
 * Split out of the worker for the same reason `vision/scan-set.ts` is: the
 * worker pulls in sharp and is not importable from a test without dragging a
 * native module along, and this is pure arithmetic over listing rows.
 *
 * ## Derivation state is a query, not a field
 *
 * There is no `needs-derivation` flag anywhere, deliberately. A shared mutable
 * "somebody should fix this" invites two nodes to derive the same record and
 * produce two rows. What is missing is simply which applicable rungs Photos'
 * own rendition table has no row for.
 *
 * That is what makes a whole-library sweep affordable. Asking per record would
 * be three queries per record per pass; asking per page is three per two
 * hundred — the records, their renditions, and which of those bytes are here.
 */

import {
  applicableStillClasses,
  applicableVideoClasses,
  renditionLongEdge,
  STILL_LADDER,
  type SizeClass,
} from "../photos-lib/ladder";
import {
  loadReadableRenditionRows,
  loadResidency,
  type SignedFetch,
} from "../photos-lib/renditions/store";

const MEDIUM_CLASS = STILL_LADDER.find((spec) => spec.sizeClass === "image-medium")!;

/** Records per listing page. A short page never means the end — see below. */
export const RECORDS_PER_PAGE = 200;

/** A row as Photos' sweep asks the data server to render it. */
export interface SweepRecord {
  id: string;
  availability?: { state: string };
  /** Canonical Starkeep type. Folder-watched records intentionally have no advisory MIME. */
  type?: string;
  mime_type: string | null;
  original_filename: string | null;
  metadata?: {
    width?: number | null;
    height?: number | null;
    thumb_hash?: string | null;
    bitrate?: number | null;
  } | null;
  /**
   * The rungs Photos' table records for this photograph, with the one
   * node-local fact the sweep needs beside each.
   *
   * Attached by {@link fetchSweepPage} rather than returned by the data server:
   * the platform holds no view of an app's private plane, which is the whole
   * point of the plane.
   */
  renditions?: Array<{
    sub_key?: string;
    size_class: string;
    long_edge: number;
    /** False when the row is here and the bytes are not. */
    available_here: boolean;
  }>;
}

/**
 * Which applicable rungs this record does not have.
 *
 * Matched by *effective long edge* rather than by class name, because that is
 * what the platform reports and what it can report without knowing a ladder
 * exists. The match is unambiguous: within a record's applicable set, effective
 * edges strictly increase — a class applies only when the source exceeds the
 * class below it, so its clamped edge exceeds that class's edge too — so an
 * edge names exactly one rung.
 *
 * Returns everything when the source's dimensions are unknown, since nothing
 * can be ruled out. That case shrinks on its own: the first derivation writes
 * the dimensions.
 */
export function missingClasses(record: SweepRecord): SizeClass[] | "unknown" {
  const sourceLongEdge = Math.max(record.metadata?.width ?? 0, record.metadata?.height ?? 0);
  if (sourceLongEdge <= 0) return "unknown";
  // A resident original can regenerate absent bytes without a network request.
  const have = new Set(
    (record.renditions ?? [])
      .filter(c => c.available_here)
      .map((c) => c.long_edge),
  );
  return applicableStillClasses(sourceLongEdge)
    .filter((spec) => !have.has(renditionLongEdge(spec, sourceLongEdge)))
    .map((spec) => spec.sizeClass);
}

/** Whether the record still lacks the facts one decode would produce. */
export function needsRecordFacts(record: SweepRecord): boolean {
  const hasDimensions = (record.metadata?.width ?? 0) > 0 && (record.metadata?.height ?? 0) > 0;
  return !hasDimensions || !record.metadata?.thumb_hash;
}

/**
 * Whether this stage has anything to do for this record.
 *
 * The `cheap` stage covers the placeholder, the record's own facts and the
 * bottom rungs; `medium` covers everything above the cheap tier up to and
 * including the medium rung; `full` covers everything above that. A record with
 * unknown dimensions always has cheap work — that pass is what makes them
 * known.
 */
export function stageHasWork(
  record: SweepRecord,
  stage: "cheap" | "medium" | "full" | "video",
  cheapClasses: readonly SizeClass[],
): boolean {
  const mediaType = record.mime_type ?? record.type ?? "";
  const video = mediaType.startsWith("video/");
  if (stage === "video") {
    if (!video) return false;
    const longEdge = Math.max(record.metadata?.width ?? 0, record.metadata?.height ?? 0);
    // The first pass supplies these facts. Until they exist, no duplicated
    // approximation of the ladder can safely decide which rungs apply.
    if (longEdge <= 0) return true;
    const have = new Set(
      (record.renditions ?? [])
        .filter(c => c.available_here)
        .map((c) => c.size_class),
    );
    const bitrate = record.metadata?.bitrate ?? Number.POSITIVE_INFINITY;
    return applicableVideoClasses({ longEdge, bitrate, durationSeconds: 0 }).some(
      (spec) => !have.has(spec.sizeClass),
    );
  }
  if (video || !mediaType.startsWith("image/")) return false;
  const missing = missingClasses(record);
  if (missing === "unknown") return true;
  const cheap = new Set(cheapClasses);
  if (stage === "cheap") return needsRecordFacts(record) || missing.some((c) => cheap.has(c));
  return missing.some((sizeClass) => stillStage(sizeClass, cheap) === stage);
}

/**
 * Which non-cheap stage owns a still rung.
 *
 * Stated as two open ranges over the ladder rather than as "the medium rung
 * exactly, and everything above it". The rungs are what move in a respec, and
 * an equality test against one of them silently orphans any rung added between
 * the cheap tier and medium: such a rung would belong to no stage, so no sweep
 * would ever derive it and only an on-demand request would produce one. Ranges
 * make the three stages cover the ladder by construction, which is a property a
 * respec cannot break.
 */
function stillStage(sizeClass: SizeClass, cheap: ReadonlySet<SizeClass>): "cheap" | "medium" | "full" {
  if (cheap.has(sizeClass)) return "cheap";
  const spec = STILL_LADDER.find((s) => s.sizeClass === sizeClass);
  if (!spec) return "full";
  return spec.maxLongEdge <= MEDIUM_CLASS.maxLongEdge ? "medium" : "full";
}

/** `fetch`-alike over the data server, injected so this module owns no creds. */
export type RecordFetcher = SignedFetch;

export interface SweepPage {
  records: SweepRecord[];
  nextCursor: string | null;
}

/**
 * One page of records the sweep may have work for, with its renditions.
 *
 * Renditions are excluded from the page by label rather than by parent, because
 * a Live Photo clip has a parent too and a clip is user data that wants its own
 * tile. Nothing publishes that label any more; the filter is what keeps rungs
 * published before renditions moved off the shared plane out of the sweep.
 *
 * Three requests per page, not one. The records come from the shared plane, the
 * rendition rows from Photos' own table, and local byte availability from this
 * node's resident set — three different owners, and the platform deliberately
 * holds no joined view across them.
 */
export async function fetchSweepPage(
  fetchRecords: RecordFetcher,
  renditionLabelRef: string,
  cursor: string | null,
  pageSize: number = RECORDS_PER_PAGE,
): Promise<SweepPage> {
  const params = [
    `limit=${pageSize}`,
    "include=metadata,labels",
    `notLabel=${encodeURIComponent(renditionLabelRef)}`,
  ];
  if (cursor) params.push(`page_token=${encodeURIComponent(cursor)}`);
  const res = await fetchRecords(`/data/records?${params.join("&")}`);
  if (!res.ok) throw new Error(`list records failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    records: SweepRecord[];
    nextCursor?: string | null;
  };

  await attachRenditions(fetchRecords, body.records);

  // A short page is not the end — only an exhausted cursor is. `?? null`
  // because a server older than the contract omits the field entirely, and
  // `undefined !== null` loops forever.
  return { records: body.records, nextCursor: body.nextCursor ?? null };
}

/** Hang each record's rungs off it, with local availability resolved. */
export async function attachRenditions(
  signedFetch: SignedFetch,
  records: SweepRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const rows = await loadReadableRenditionRows(signedFetch, records.map((r) => r.id));
  const subKeys = [...rows.values()].flat().map((row) => row.sub_key);
  const residency = subKeys.length > 0 ? await loadResidency(signedFetch, subKeys) : new Map();
  for (const record of records) {
    record.renditions = (rows.get(record.id) ?? []).map((row) => ({
      sub_key: row.sub_key,
      size_class: row.size_class,
      long_edge: Math.max(row.width, row.height),
      available_here: residency.get(row.sub_key) ?? false,
    }));
  }
}
