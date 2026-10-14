/**
 * Which copy of a video the viewer plays, and which copy it fetches.
 *
 * ## The rule
 *
 * The smallest copy whose frame covers the viewer's stage. On a phone that is
 * usually the 720p copy, a few megabytes against an original of tens or
 * hundreds. The original plays only when it is already on this device, or when
 * the person asks for it.
 *
 * ## Why the frame size comes from the library's standards
 *
 * A video stand-in's fidelity is its bitrate, and a stand-in carries no
 * metadata row, so nothing on the record states its frame size. The library's
 * advisory long edges are what the encoder was told: the canonical copy at
 * `advisoryLongEdges.canonical`, and each smaller copy at
 * `advisoryLongEdges.bySize[kbps]`. The encoder never upscales, so a copy's
 * frame is the smaller of that edge and the original's own long edge. This is
 * the arithmetic Photos' encoder applies (`transcodeLongEdge` in
 * `@starkeep/photos-ladder`).
 *
 * A copy whose edge the standards do not name has no known frame size. It is
 * still a candidate, ranked by bitrate, but it never counts as covering the
 * stage.
 */

import { typeCategory, type AdvisoryLongEdges, type DataRecord, type StarkeepId } from "@starkeep/protocol-primitives";
import type { DatabaseAdapter } from "@starkeep/storage-adapter";

export interface VideoCopy {
  readonly id: StarkeepId;
  readonly objectStorageKey: string;
  /** Bitrate in kbps: the stand-in's fidelity. */
  readonly kbps: number;
  /** The frame's long edge, or null when nothing states it. */
  readonly longEdge: number | null;
  readonly resident: boolean;
}

export interface VideoPlayback {
  /** The copy to play now, which is on this device; null for none. */
  readonly play: VideoCopy | null;
  /** The copy to fetch, whose bytes are not here; null when nothing should move. */
  readonly fetch: VideoCopy | null;
}

/** A video original's stand-ins, with the frame size each was encoded at. */
export function videoCopies(
  standIns: readonly DataRecord[],
  options: {
    readonly edges: AdvisoryLongEdges | null;
    /** The original's long edge, or null when unknown. */
    readonly sourceLongEdge: number | null;
    readonly isResident: (objectStorageKey: string) => boolean;
  },
): VideoCopy[] {
  const out: VideoCopy[] = [];
  for (const s of standIns) {
    if (typeCategory(s.type) !== "video" || !s.objectStorageKey || typeof s.fidelity !== "number") continue;
    const advisory =
      options.edges === null
        ? null
        : s.standInRole === "canonical"
          ? options.edges.canonical
          : (options.edges.bySize[s.fidelity] ?? null);
    const longEdge =
      advisory === null
        ? null
        : options.sourceLongEdge !== null && options.sourceLongEdge > 0
          ? Math.min(advisory, options.sourceLongEdge)
          : advisory;
    out.push({
      id: s.id as StarkeepId,
      objectStorageKey: s.objectStorageKey,
      kbps: s.fidelity,
      longEdge,
      resident: options.isResident(s.objectStorageKey),
    });
  }
  return out.sort((a, b) => a.kbps - b.kbps);
}

/**
 * The copy to play and the copy to fetch, for a stage that wants `target`
 * physical pixels on its long edge.
 *
 * 1. With the original here, the original plays and nothing moves.
 * 2. Otherwise the ideal is the smallest copy covering the target, or the
 *    largest copy when none covers it.
 * 3. A resident copy covering the target plays as it is, the smallest such.
 *    Bytes already here beat a download of a smaller file.
 * 4. Otherwise the ideal is fetched, and the largest resident copy below it
 *    plays meanwhile.
 */
export function chooseVideoPlayback(
  copies: readonly VideoCopy[],
  target: number | null,
  originalHere: boolean,
): VideoPlayback {
  if (originalHere || copies.length === 0) return { play: null, fetch: null };
  const covers = (c: VideoCopy) => target !== null && c.longEdge !== null && c.longEdge >= target;

  const residentCover = copies.find((c) => c.resident && covers(c));
  if (residentCover) return { play: residentCover, fetch: null };

  const ideal = copies.find(covers) ?? copies[copies.length - 1]!;
  if (ideal.resident) return { play: ideal, fetch: null };
  const below = copies.filter((c) => c.resident && c.kbps < ideal.kbps);
  return { play: below[below.length - 1] ?? null, fetch: ideal };
}

/**
 * The label Photos puts on every derived child: `photos/derived=<size class>`.
 * A video's posters are the two frame extractions a desktop makes, named by
 * their size class in `@starkeep/photos-ladder`.
 */
const DERIVED_LABEL = { appId: "photos", key: "derived" } as const;
const POSTER_THUMB = "video-poster-thumb";
const POSTER_720P = "video-poster-720p";

/** A video's posters, each null until a desktop has made it. */
export interface VideoPosters {
  /** About 640 pixels: what a grid tile wants. */
  readonly thumb: DataRecord | null;
  /** 720p: what the viewer wants. */
  readonly large: DataRecord | null;
}

/** Most posters one page can carry: two per video on a page of tiles. */
const MAX_POSTERS_PER_PAGE = 1000;

/**
 * The posters of a page of videos, by video id, in two queries for the page.
 *
 * A poster is a derived record rather than a stand-in, so the stand-in loader
 * never sees one. Every node receives posters whatever its ceiling, because no
 * stand-in replaces them; a poster that has arrived is on this device.
 */
export async function loadVideoPosters(
  database: Pick<DatabaseAdapter, "query" | "getLabelsByRecordIds">,
  records: readonly DataRecord[],
): Promise<Map<StarkeepId, VideoPosters>> {
  const out = new Map<StarkeepId, VideoPosters>();
  const videos = records.filter((r) => typeCategory(r.type) === "video" && !r.deletedAt);
  if (videos.length === 0) return out;
  const children = await database.query({
    filters: [
      { field: "parentId", operator: "in", value: videos.map((r) => r.id) },
      { field: "standInRole", operator: "isNull" },
      { field: "deletedAt", operator: "isNull" },
    ],
    limit: MAX_POSTERS_PER_PAGE,
  });
  const stills = children.records.filter((c) => typeCategory(c.type) === "image" && c.parentId);
  if (stills.length === 0) return out;
  const labels = await database.getLabelsByRecordIds(stills.map((c) => c.id as StarkeepId));
  for (const child of stills) {
    const sizeClass = (labels.get(child.id as StarkeepId) ?? []).find(
      (l) => l.appId === DERIVED_LABEL.appId && l.key === DERIVED_LABEL.key && !l.deletedAt,
    )?.value;
    if (sizeClass !== POSTER_THUMB && sizeClass !== POSTER_720P) continue;
    const parentId = child.parentId as StarkeepId;
    const current = out.get(parentId) ?? { thumb: null, large: null };
    out.set(
      parentId,
      sizeClass === POSTER_THUMB ? { ...current, thumb: child } : { ...current, large: child },
    );
  }
  return out;
}
