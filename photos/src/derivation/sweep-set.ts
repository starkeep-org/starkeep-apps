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
  applicableVideoClasses,
  renditionLongEdge,
  STILL_LADDER,
  type SizeClass,
} from "../photos-lib/ladder";
import {
  withStandInCandidates,
  type WireStandInSummary,
} from "../photos-lib/stand-in-candidates";

const MEDIUM_CLASS = STILL_LADDER.find((spec) => spec.sizeClass === "image-medium")!;

/** Records per listing page. A short page never means the end — see below. */
export const RECORDS_PER_PAGE = 200;

/** A row as Photos' sweep asks the data server to render it. */
export interface SweepRecord {
  id: string;
  /** Canonical Starkeep type. Folder-watched records intentionally have no advisory MIME. */
  type?: string;
  mime_type: string | null;
  original_filename: string | null;
  /** Decides, with the long edge, whether the original takes a canonical rung. */
  size_bytes?: number | null;
  /** The original's fidelity as the platform records it; null when unreported. */
  fidelity?: number | null;
  /** The platform's size summary; folded into `variant_candidates` on fetch. */
  stand_ins?: WireStandInSummary;
  metadata?: {
    width?: number | null;
    height?: number | null;
    thumb_hash?: string | null;
    bitrate?: number | null;
  } | null;
  variant_candidates?: Array<{
    long_edge: number;
    label_value?: string;
    /** False when the child record exists but its bytes are absent on this node. */
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
  // A rung that exists anywhere is a rung this node need not derive. The
  // platform keeps one stand-in per size per original, so a second encode here
  // would be refused and reused rather than stored; and whether its bytes sit
  // on this node is the platform's residency decision — a stand-in within the
  // node's ceiling arrives by sync, one above it arrives when asked for.
  const have = new Set((record.variant_candidates ?? []).map((c) => c.long_edge));
  return applicableStillClasses(sourceLongEdge, record.size_bytes)
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
    const have = new Set((record.variant_candidates ?? []).map((c) => c.label_value));
    const bitrate = record.metadata?.bitrate ?? Number.POSITIVE_INFINITY;
    return applicableVideoClasses({ longEdge, bitrate, durationSeconds: 0 }).some(
      (spec) => !have.has(spec.sizeClass),
    );
  }
  if (video || !mediaType.startsWith("image/")) return false;
  const missing = missingClasses(record);
  if (missing === "unknown") return true;
  const cheap = new Set(cheapClasses);
  if (stage === "cheap") {
    // An unreported fidelity is cheap work: the stored dimensions answer it
    // without a decode, and until it is reported the platform cannot place the
    // original against any node's ceiling.
    return needsRecordFacts(record) || record.fidelity === null || missing.some((c) => cheap.has(c));
  }
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

/**
 * Whether the sweep may read this record's original under the machine's
 * switches. Any read of an original this machine lacks downloads it and keeps
 * it, so with downloads off only an original known to be here qualifies.
 */
export function originalReadable(record: SweepRecord, mayDownload: boolean): boolean {
  return mayDownload || record.stand_ins?.original_placement === "here";
}

/**
 * The fidelity a still's stored dimensions answer without a decode, or null
 * when the record has one already, is not a still, or has no dimensions yet.
 *
 * Reported whatever the switches say: it costs one request and no bytes, and
 * without it no node can place the original against its ceiling.
 */
export function fidelityWithoutDecode(record: SweepRecord): number | null {
  if (record.fidelity !== null) return null;
  const mediaType = record.mime_type ?? record.type ?? "";
  if (!mediaType.startsWith("image/")) return null;
  const longEdge = Math.max(record.metadata?.width ?? 0, record.metadata?.height ?? 0);
  return longEdge > 0 ? longEdge : null;
}

/** The switches one pass runs under. See `derivation/config.ts`. */
export interface SweepSwitches {
  readonly derivePhotoStandIns: boolean;
  readonly deriveVideoStandIns: boolean;
  /** Downloads allowed and at least one derive switch on. */
  readonly mayDownload: boolean;
}

/**
 * The records of one page this stage derives under the machine's switches:
 * none when the stage's switch is off, and with downloads off only those whose
 * original is already here.
 */
export function sweepWork(
  records: readonly SweepRecord[],
  stage: "cheap" | "medium" | "full" | "video",
  switches: SweepSwitches,
  cheapClasses: readonly SizeClass[],
): SweepRecord[] {
  const stageOn = stage === "video" ? switches.deriveVideoStandIns : switches.derivePhotoStandIns;
  if (!stageOn) return [];
  return records.filter(
    (r) => stageHasWork(r, stage, cheapClasses) && originalReadable(r, switches.mayDownload),
  );
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
 * the whole point: resolution would answer "which rung best fits 640 px" when
 * the question is "which rungs are missing".
 */
export async function fetchSweepPage(
  fetchRecords: RecordFetcher,
  derivedLabelRef: string,
  cursor: string | null,
  pageSize: number = RECORDS_PER_PAGE,
): Promise<SweepPage> {
  const params = [
    `limit=${pageSize}`,
    "include=metadata,labels",
    // The platform leaves stand-ins out and summarises them on each original;
    // posters and skims are derived records, so Photos leaves out its own and
    // asks for them as candidates.
    `notLabel=${encodeURIComponent(derivedLabelRef)}`,
    `variant=${encodeURIComponent(derivedLabelRef)}`,
  ];
  if (cursor) params.push(`page_token=${encodeURIComponent(cursor)}`);
  const res = await fetchRecords(`/data/records?${params.join("&")}`);
  if (!res.ok) throw new Error(`list records failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    records: SweepRecord[];
    nextCursor?: string | null;
  };
  // A short page is not the end — only an exhausted cursor is. `?? null`
  // because a server older than the contract omits the field entirely, and
  // `undefined !== null` loops forever.
  return {
    records: body.records.map((record) => withStandInCandidates(record)),
    nextCursor: body.nextCursor ?? null,
  };
}
