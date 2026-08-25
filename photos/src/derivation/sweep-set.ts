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
 * produce two children. What is missing is simply which applicable rungs have
 * no child record — and the list response carries the answer, because the data
 * server can be asked for every derived child of a page with its dimensions.
 *
 * That is what makes a whole-library sweep affordable. Asking per record would
 * be two queries per record per pass; asking per page is two per two hundred.
 */

import {
  applicableStillClasses,
  renditionLongEdge,
  type SizeClass,
} from "../photos-lib/ladder";

/** Records per listing page. A short page never means the end — see below. */
export const RECORDS_PER_PAGE = 200;

/** A row as Photos' sweep asks the data server to render it. */
export interface SweepRecord {
  id: string;
  mime_type: string | null;
  original_filename: string | null;
  metadata?: {
    width?: number | null;
    height?: number | null;
    thumb_hash?: string | null;
  } | null;
  variant_candidates?: Array<{ long_edge: number }>;
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
  const have = new Set((record.variant_candidates ?? []).map((c) => c.long_edge));
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
 * bottom rungs; `full` covers whatever else the ladder calls for. A record with
 * unknown dimensions always has cheap work — that pass is what makes them
 * known.
 */
export function stageHasWork(
  record: SweepRecord,
  stage: "cheap" | "full",
  cheapClasses: readonly SizeClass[],
): boolean {
  const missing = missingClasses(record);
  if (missing === "unknown") return true;
  const cheap = new Set(cheapClasses);
  return stage === "cheap"
    ? needsRecordFacts(record) || missing.some((c) => cheap.has(c))
    : missing.some((c) => !cheap.has(c));
}

/** `fetch`-alike over the data server, injected so this module owns no creds. */
export type RecordFetcher = (path: string) => Promise<Response>;

export interface SweepPage {
  records: SweepRecord[];
  nextCursor: string | null;
}

/**
 * One page of records the sweep may have work for.
 *
 * Renditions are excluded by label rather than by parent, because a crop has a
 * parent too and a crop is a user artifact that wants its own tile. Reading
 * `parent_id !== null` as "is a rendition" is the mistake `photos-lib/labels.ts`
 * exists to stop repeating.
 *
 * `variant` with no pixel size asks for the unnarrowed candidate list, which is
 * the whole point: resolution would answer "which rung best fits 400 px" when
 * the question is "which rungs are missing".
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
    `variant=${encodeURIComponent(renditionLabelRef)}`,
  ];
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  const res = await fetchRecords(`/data/records?${params.join("&")}`);
  if (!res.ok) throw new Error(`list records failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    records: SweepRecord[];
    nextCursor?: string | null;
  };
  // A short page is not the end — only an exhausted cursor is. `?? null`
  // because a server older than the contract omits the field entirely, and
  // `undefined !== null` loops forever.
  return { records: body.records, nextCursor: body.nextCursor ?? null };
}
