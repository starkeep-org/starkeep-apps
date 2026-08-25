import { NextResponse, type NextRequest } from "next/server";
import { loadAppCredentials, signedFetch, USER_TOKEN_HEADER } from "@starkeep/app-client";
import { RENDITION_LABEL_REF } from "@/photos-lib/image-processing/publish-renditions";
import { cloudCanDecode } from "@/photos-lib/image-processing/derive-ladder";
import {
  resolveRenditions,
  resolveWithoutDimensions,
  type DerivedChild,
  type RenditionState,
} from "@/photos-lib/rendition-resolution";
import { MAX_VARIANT_TARGETS } from "@/photos-lib/rendition-targets";
import { VIDEO_LADDER } from "@/photos-lib/ladder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
 * That layer is `createNextProxyHandler`, and it is the platform's, shared by
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
export async function GET(req: NextRequest): Promise<Response> {
  const cloud = process.env.STARKEEP_APP_CLIENT_MODE === "cloud";

  let userToken: string | undefined;
  let refreshedCookie: string | undefined;
  if (cloud) {
    const { requireSession, mintIdToken } = await import("@starkeep/app-client/auth");
    if ((await requireSession(req)) === null) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    // Minted rather than read straight from the cookie: the token is good for
    // about an hour and the session outlives it, so a near-expired one is
    // replaced here and the browser is told to keep the new one. Forwarding a
    // token the broker is about to start refusing produces a failure an hour
    // into a session with nothing in the request to explain it.
    const minted = await mintIdToken(req, "photos");
    if (minted) {
      userToken = minted.token;
      refreshedCookie = minted.setCookie;
    }
  }

  const creds = await loadAppCredentials("photos");
  if (!creds) {
    return NextResponse.json(
      { error: "photos has not been installed locally — run install from admin-web first" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const targets = parseTargets(url.searchParams.get("targets"));
  if (!targets.ok) return NextResponse.json({ error: targets.message }, { status: 400 });

  const params = [
    `limit=${clampLimit(url.searchParams.get("limit"))}`,
    "include=metadata,labels",
    // Renditions are excluded from the page and returned *on* their parents.
    // With a ladder, a 60k-item library is 300k+ records, and a page that mixes
    // them is a page the client cannot use — it cannot tell how far to keep
    // reading.
    `notLabel=${encodeURIComponent(RENDITION_LABEL_REF)}`,
    // No `variantLongEdge`: the unnarrowed list is the point. Resolution
    // happens here, against the ladder, which the data server must not learn.
    `variant=${encodeURIComponent(RENDITION_LABEL_REF)}`,
  ];
  const updatedAfter = url.searchParams.get("updated_after");
  if (updatedAfter) params.push(`updated_after=${encodeURIComponent(updatedAfter)}`);
  const cursor = url.searchParams.get("cursor");
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);

  const upstream = await signedFetch(creds, `/data/records?${params.join("&")}`, {
    ...(userToken ? { headers: { [USER_TOKEN_HEADER]: userToken } } : {}),
  });
  if (!upstream.ok) {
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const body = (await upstream.json()) as {
    records: UpstreamRecord[];
    hasMore?: boolean;
    nextCursor?: string | null;
  };

  // What this node would say about a source it cannot read. Locally that is a
  // durable per-record verdict written by whatever last tried; in the cloud it
  // is a property of the format, because the cloud's decoder set is fixed and
  // known. Both are "here", which is what the flag means.
  const localVerdicts = cloud ? null : await loadLocalVerdicts();

  const records = body.records.map((record) => {
    const { variant_candidates: _dropped, ...rest } = record;
    return {
      ...rest,
      ...(isVideo(record)
        ? { video_renditions: resolveVideo(record, targets.values, cloud) }
        : { renditions: resolveFor(record, targets.values, cloud, localVerdicts) }),
    };
  });

  const res = NextResponse.json({
    records,
    hasMore: body.hasMore ?? false,
    nextCursor: body.nextCursor ?? null,
  });
  if (refreshedCookie) res.headers.append("Set-Cookie", refreshedCookie);
  return res;
}

export interface UpstreamRecord {
  id: string;
  mime_type: string | null;
  metadata?: { width?: number | null; height?: number | null } | null;
  variant_candidates?: Array<{
    id: string;
    type: string;
    width: number;
    height: number;
    long_edge: number;
    label_value: string;
    available_here: boolean;
    url?: string;
  }>;
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
  return (record.mime_type ?? "").startsWith("video/");
}

/**
 * Today's resolution, for the records the ladder shape does not fit.
 *
 * A round-up over what exists, keyed by the requested size — byte-for-byte the
 * shape the data server used to return, so every video consumer keeps working
 * unchanged.
 */
export function resolveVideo(record: UpstreamRecord, targets: readonly number[], cloud: boolean) {
  const candidates = record.variant_candidates ?? [];
  const posterClasses = new Set(VIDEO_LADDER.filter((spec) => spec.kind === "poster").map((spec) => spec.sizeClass));
  const playbackClasses = new Set(VIDEO_LADDER.filter((spec) => spec.kind === "transcode").map((spec) => spec.sizeClass));
  const posters = candidates.filter((c) => posterClasses.has(c.label_value as never));
  const playback = candidates.filter((c) => playbackClasses.has(c.label_value as never));
  const out: Record<string, { poster?: (typeof candidates)[number]; playback?: (typeof candidates)[number] }> = {};
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

/** Exact/next-larger, then largest-smaller, restricted to bytes this node can serve. */
function chooseVideoCandidate(
  candidates: NonNullable<UpstreamRecord["variant_candidates"]>,
  target: number,
  cloud: boolean,
) {
  const readable = candidates
    .filter((c) => Boolean(c.url) && (cloud || c.available_here))
    .sort((a, b) => a.long_edge - b.long_edge || a.id.localeCompare(b.id));
  return readable.find((c) => c.long_edge >= target) ?? readable[readable.length - 1];
}

function resolveFor(
  record: UpstreamRecord,
  targets: readonly number[],
  cloud: boolean,
  localVerdicts: ReadonlyMap<string, RenditionState> | null,
) {
  const candidates: DerivedChild[] = (record.variant_candidates ?? []).map((c) => ({
    id: c.id,
    longEdge: c.long_edge,
    width: c.width,
    height: c.height,
    type: c.type,
    ...(c.url ? { url: c.url } : {}),
  }));

  const sourceLongEdge = Math.max(record.metadata?.width ?? 0, record.metadata?.height ?? 0);
  // No stored dimensions means no applicable set, so there is no ideal to name.
  // A shrinking case — derivation writes dimensions now — but not yet an empty
  // one, so it still needs a defined answer.
  if (sourceLongEdge <= 0) return resolveWithoutDimensions(targets, candidates);

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
    return cloudCanDecode(record.mime_type ?? "") ? "pending" : "undecodable-here";
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
async function loadLocalVerdicts(): Promise<ReadonlyMap<string, RenditionState>> {
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
