import { authorizePhotosRoute, withRefreshedSession } from "@/lib/photos-route-server";
import { RENDITION_LABEL_REF } from "@/photos-lib/labels";
import { cloudCanDecode } from "@/photos-lib/image-processing/derive-ladder";
import { renditionCandidate } from "@/photos-lib/ladder";
import type { HydratedRendition } from "@/photos-lib/renditions/store";
import {
  resolveRenditions,
  resolveWithoutDimensions,
  type DerivedChild,
  type RenditionState,
} from "@/photos-lib/rendition-resolution";
import { MAX_VARIANT_TARGETS } from "@/photos-lib/rendition-targets";
import { VIDEO_LADDER } from "@/photos-lib/ladder";
import { currentRenditionPolicies } from "@/photos-lib/rendition-policy";
import { LIBRARY_ORDER } from "@/photos-lib/capture-order";

/**
 * GET /api/photos/library — the record list, with renditions resolved against
 * Photos' ladder.
 *
 * ## Why this is not the generic proxy
 *
 * Every data-plane call the browser makes already routes through Photos' own
 * same-origin proxy, which HMAC-signs server-side, in both local and cloud
 * mode. So the layer that should resolve the ladder was already sitting on
 * every request; what it lacked was a reason to look.
 *
 * That layer is `createDataProxyHandler`, and it is the platform's, shared by
 * every app. Teaching it what a size class is would put an app concept one
 * level down for no gain. So the list path gets its own Photos-owned route and
 * everything else still falls through the generic proxy untouched.
 *
 * ## What each side answers
 *
 * The data server answers "what derived children does this record have, and how
 * big is each" — app-agnostic, and a set it already computes. This route
 * answers the Photos question: which rung *should* answer the requested size
 * for this record, whether it exists yet, and what to paint meanwhile.
 *
 * ## The auth here is the proxy's auth, on purpose
 *
 * Same gate, same order: the session is checked before the HMAC credential is
 * loaded, so a caller with no session never causes the secret to be read. Local
 * mode stays open, because on the loopback surface the browser, the data and
 * the person are all on one machine and gating on-device data behind a sign-in
 * would break local-first.
 */
export async function GET(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;

  const url = new URL(req.url);

  const updatedAfter = url.searchParams.get("updated_after");
  const params = [
    `limit=${clampLimit(url.searchParams.get("limit"))}`,
    "include=metadata,labels",
    // Renditions are excluded from the page and returned *on* their parents.
    // With a ladder, a 60k-item library is 300k+ records, and a page that mixes
    // them is a page the client cannot use — it cannot tell how far to keep
    // reading.
    `notLabel=${encodeURIComponent(RENDITION_LABEL_REF)}`,
  ];
  if (updatedAfter) {
    // The delta is cut in the order the caller is walking, which is sync time.
    //
    // `updated_after` selects what has changed, and the client's watermark is
    // the maximum `updated_at` of what came back. That is only a safe watermark
    // when the page is a genuine *prefix* of the set being walked: order by
    // anything else and a full page hands back an arbitrary slice, the client
    // advances past everything it did not receive, and `updated_after` being a
    // strict lower bound means no later round ever offers the remainder. The
    // records are silently lost from the grid until a full reload.
    //
    // The route's old default, `id asc`, had exactly that shape. Capture order
    // — what the full list below takes — would be worse again, cutting the page
    // at the most recently *photographed* of the changes, which has nothing to
    // do with when a record changed.
    //
    // With `updated_at.asc` the maximum of a page is a correct watermark: every
    // record not returned sorts above it, and the next tick asks for it. The
    // client drains `hasMore` rather than waiting a tick per page — see
    // `fetchSince` in `src/lib/usePhotoFreshness.ts`.
    params.push(`updated_after=${encodeURIComponent(updatedAfter)}`);
    params.push("order=updated_at.asc");
  } else {
    // Capture order, which is what makes a page of this library a *slice* of it
    // rather than an arbitrary sample. Without it the route answered `id asc`,
    // so a page carried scattered capture dates and the grid grouped whatever
    // arrived; with a library past the page size, the records a viewer saw were
    // whichever ones sorted first by content-addressed id.
    //
    // `created_at` is the second key rather than a fallback folded into the
    // first: the platform refuses to coalesce the two because an ISO-8601
    // capture time and a serialized HLC sort against each other for lexical
    // reasons that have nothing to do with time. Named as a second key it gives
    // the records with no capture time a trailing block ordered by import time.
    //
    // `photos-lib/capture-order.ts` holds the same order for the client, and a
    // test pins the two together — the grid has to sort by the key the page was
    // cut on or a continued page arrives out of order.
    params.push(`order=${LIBRARY_ORDER}`);
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor) params.push(`page_token=${encodeURIComponent(cursor)}`);

  const upstreamStartedAt = Date.now();
  const upstream = await authorized.fetch(`/data/records?${params.join("&")}`);
  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const body = (await upstream.json()) as {
    records: UpstreamRecord[];
    hasMore?: boolean;
    nextCursor?: string | null;
  };

  console.log(
    `[photos-library] records=${body.records.length} baseOnly=true ` +
      `upstreamMs=${Date.now() - upstreamStartedAt} totalMs=${Date.now() - startedAt}`,
  );

  return withRefreshedSession(Response.json({
    records: body.records,
    hasMore: body.hasMore ?? false,
    nextCursor: body.nextCursor ?? null,
    policies: currentRenditionPolicies(),
  }), authorized.refreshedCookie);
}

export interface UpstreamRecord {
  id: string;
  type?: string;
  mime_type: string | null;
  metadata?: { width?: number | null; height?: number | null } | null;
}

/**
 * Video is left alone deliberately.
 *
 * Ideal-and-fallback is a statement about the *still* ladder. A video record's
 * children are posters, a skim and transcodes, and two of them legitimately
 * share a long edge — `video-poster-720p` and `video-720p` are both 1280 — so
 * "the rung at 1280" is not a well-formed question for one. Video keeps the
 * existing type-filtered resolution until its own ladder gets the same
 * treatment.
 */
function isVideo(record: UpstreamRecord): boolean {
  return (record.mime_type ?? record.type ?? "").startsWith("video/");
}

/**
 * Today's resolution, for the records the ladder shape does not fit.
 *
 * A round-up over what exists, keyed by the requested size — byte-for-byte the
 * shape the data server used to return, so every video consumer keeps working
 * unchanged.
 */
export function resolveVideo(
  renditions: readonly HydratedRendition[],
  targets: readonly number[],
  cloud: boolean,
) {
  const posterClasses = new Set(VIDEO_LADDER.filter((spec) => spec.kind === "poster").map((spec) => spec.sizeClass));
  const playbackClasses = new Set(VIDEO_LADDER.filter((spec) => spec.kind === "transcode").map((spec) => spec.sizeClass));
  const posters = renditions.filter((r) => posterClasses.has(r.size_class as never));
  const playback = renditions.filter((r) => playbackClasses.has(r.size_class as never));
  const out: Record<string, { poster?: VideoEntry; playback?: VideoEntry }> = {};
  for (const target of targets) {
    const poster = chooseVideoCandidate(posters, target, cloud);
    const playable = chooseVideoCandidate(playback, target, cloud);
    out[String(target)] = {
      ...(poster ? { poster } : {}),
      ...(playable ? { playback: playable } : {}),
    };
  }
  return out;
}

/** What a video decision hands the browser for one rung. */
export interface VideoEntry {
  id: string;
  type: string;
  label_value: string;
  width: number;
  height: number;
  long_edge: number;
  available_here: boolean;
  url?: string;
}

function videoEntry(row: HydratedRendition): VideoEntry {
  return {
    // The sub-key stands in for the record id the client used to key on: same
    // stability, same purpose, and no shared record left to take one from.
    id: row.sub_key,
    type: row.content_type,
    label_value: row.size_class,
    width: row.width,
    height: row.height,
    long_edge: Math.max(row.width, row.height),
    available_here: row.availableHere,
    ...(row.url ? { url: row.url } : {}),
  };
}

/** Exact/next-larger, then largest-smaller, restricted to bytes this node can serve. */
function chooseVideoCandidate(
  rows: readonly HydratedRendition[],
  target: number,
  cloud: boolean,
): VideoEntry | undefined {
  const readable = rows
    .filter((r) => Boolean(r.url) && (cloud || r.availableHere))
    .map(videoEntry)
    .sort((a, b) => a.long_edge - b.long_edge || a.id.localeCompare(b.id));
  return readable.find((c) => c.long_edge >= target) ?? readable[readable.length - 1];
}

export function resolveFor(
  record: UpstreamRecord,
  renditions: readonly HydratedRendition[],
  targets: readonly number[],
  cloud: boolean,
  localVerdicts: ReadonlyMap<string, RenditionState> | null,
) {
  // A rendition row can outlive its bytes on this node, and now does so as the
  // ordinary case: a round applies Photos' rows and never pulls its blobs, so a
  // rung derived on the desktop reaches the handset as a row alone. Such a row
  // is not an available rendition for this response. Passing it to the resolver
  // would mark the ideal available on the strength of a row; the browser would
  // then receive no URL, paint the ThumbHash forever, and never ask again.
  //
  // In cloud mode the URL points at bytes the cloud holds whether or not this
  // node does, which is why residency is not consulted there. Same readability
  // rule as the video candidates above.
  const candidates: DerivedChild[] = renditions
    .filter((r) => Boolean(r.url) && (cloud || r.availableHere))
    .map((r) => renditionCandidate(r, r.url));

  const sourceLongEdge = Math.max(record.metadata?.width ?? 0, record.metadata?.height ?? 0);
  // No stored dimensions means no applicable set, so the exact clamped rung
  // cannot be named yet. The compatibility resolver returns existing children
  // as available, or provisional pending targets when there are none. That
  // pending shape is what tells a parent-cursor client to full-relist for the
  // first child publication instead of discovering every cheap child at once.
  if (sourceLongEdge <= 0) {
    return resolveWithoutDimensions(
      targets,
      candidates,
      unavailableState(record, cloud, localVerdicts),
    );
  }

  return resolveRenditions(targets, {
    sourceLongEdge,
    candidates,
    unavailableState: unavailableState(record, cloud, localVerdicts),
  });
}

function unavailableState(
  record: UpstreamRecord,
  cloud: boolean,
  localVerdicts: ReadonlyMap<string, RenditionState> | null,
): RenditionState {
  if (cloud) {
    // The cloud's decoder set is fixed: JPEG, PNG, WebP and AVIF. A HEIC record
    // is not "still deriving" there and never will be, and saying `pending`
    // would leave a grey tile that looks exactly like a bug.
    return cloudCanDecode(record.mime_type ?? record.type ?? "") ? "pending" : "undecodable-here";
  }
  return localVerdicts?.get(record.id) ?? "pending";
}

/**
 * This node's own verdicts, read from the ledger the derivation path writes.
 *
 * Node-local by design: "this machine has no HEIC decoder" is a fact about one
 * machine, and a verdict that travelled would let a phone's failure tell a
 * laptop not to bother with a file the laptop reads fine.
 */
export async function loadLocalVerdicts(): Promise<ReadonlyMap<string, RenditionState>> {
  const { allAttempts } = await import("@/derivation/attempt-store");
  const out = new Map<string, RenditionState>();
  for (const [recordId, attempt] of allAttempts()) {
    if (attempt.outcome === "undecodable-here") out.set(recordId, "undecodable-here");
  }
  return out;
}

function parseTargets(
  raw: string | null,
): { ok: true; values: number[] } | { ok: false; message: string } {
  if (raw === null) return { ok: false, message: "targets is required" };
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, message: "targets must list at least one size" };
  if (parts.length > MAX_VARIANT_TARGETS) {
    return {
      ok: false,
      message: `targets accepts at most ${MAX_VARIANT_TARGETS} sizes (got ${parts.length})`,
    };
  }
  const values: number[] = [];
  for (const part of parts) {
    // Explicitly not parseInt, which accepts "400px" and "12abc" — the kind of
    // input that comes from string-concatenating a CSS value.
    if (!/^\d+$/.test(part) || Number(part) <= 0) {
      return { ok: false, message: `targets must be whole positive pixel sizes (got "${part}")` };
    }
    values.push(Number(part));
  }
  return { ok: true, values: [...new Set(values)] };
}

function clampLimit(raw: string | null): number {
  const parsed = raw === null ? 500 : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 500;
  return Math.min(Math.floor(parsed), 500);
}
