import {
  canonicalTarget,
  currentRenditionPolicies,
  type MediaPolicyKind,
  type RenditionThresholdPolicy,
} from "@/photos-lib/rendition-policy";
import { authorizePhotosRoute, withRefreshedSession } from "@/lib/photos-route-server";
import {
  loadLocalVerdicts,
  resolveFor,
  resolveVideo,
  type UpstreamRecord,
} from "./library";
import {
  loadHydratedRenditions,
  type HydratedRendition,
} from "@/photos-lib/renditions/store";

export const MAX_RENDITION_BATCH_PAIRS = 100;
/** Matches the file plane's own default, which is what mints these URLs. */
const URL_LIFETIME_SECONDS = 3600;
export const MAX_RENDITION_BATCH_RECORDS = 100;

interface RequestedResolution {
  recordId: string;
  policyVersion: string;
  requiredLongEdge: number;
  targetLongEdge: number;
}

function mediaKind(record: UpstreamRecord): MediaPolicyKind {
  return (record.mime_type ?? record.type ?? "").startsWith("video/") ? "video" : "still";
}

function coverage(policy: RenditionThresholdPolicy, target: number) {
  const index = policy.targetLongEdges.indexOf(target);
  const previous = index > 0 ? policy.targetLongEdges[index - 1]! : 0;
  return { requiredLongEdgeMin: previous + 1, requiredLongEdgeMax: target };
}

/**
 * How long the URLs in a decision are good for.
 *
 * Every rendition URL expires now, and by the same amount: the app-private file
 * plane mints a token URL locally and a presigned S3 URL in the cloud, both
 * from one `expiresIn`. The shared plane could answer `non-expiring` for a
 * record whose bytes sat behind a permanent local path; nothing on this plane
 * can, so the client's refresh path runs for every rung rather than for some.
 */
function attachStillUrlLifetime(
  decision: ReturnType<typeof resolveFor>[string],
  expiresAt: string,
) {
  const attach = <T extends { url?: string }>(entry: T): T & { urlLifetime?: unknown } =>
    entry.url ? { ...entry, urlLifetime: { kind: "expires", expires_at: expiresAt } } : entry;
  return {
    ideal: attach(decision.ideal),
    ...(decision.fallback ? { fallback: attach(decision.fallback) } : {}),
  };
}

function validateBody(value: unknown): { ok: true; requests: RequestedResolution[] } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { requests?: unknown }).requests)) {
    return { ok: false, error: "requests must be an array" };
  }
  const requests = (value as { requests: unknown[] }).requests;
  if (requests.length === 0 || requests.length > MAX_RENDITION_BATCH_PAIRS) {
    return { ok: false, error: `requests must contain 1-${MAX_RENDITION_BATCH_PAIRS} pairs` };
  }
  const normalized: RequestedResolution[] = [];
  for (const item of requests) {
    const request = item as Partial<RequestedResolution>;
    if (
      typeof request.recordId !== "string" ||
      request.recordId.length === 0 ||
      typeof request.policyVersion !== "string" ||
      !Number.isInteger(request.requiredLongEdge) ||
      request.requiredLongEdge! <= 0 ||
      !Number.isInteger(request.targetLongEdge) ||
      request.targetLongEdge! <= 0
    ) {
      return { ok: false, error: "each request needs a record ID, policy version, and positive whole-pixel edges" };
    }
    normalized.push(request as RequestedResolution);
  }
  if (new Set(normalized.map((request) => request.recordId)).size > MAX_RENDITION_BATCH_RECORDS) {
    return { ok: false, error: `a batch may address at most ${MAX_RENDITION_BATCH_RECORDS} records` };
  }
  return { ok: true, requests: normalized };
}

export async function POST(req: Request): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }
  const parsed = validateBody(raw);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const recordIds = [...new Set(parsed.requests.map((request) => request.recordId))].sort();
  const params = [
    // A bounded id list, as the grammar's `in` over the primary key. The whole
    // answer by construction, so the page carries no cursor.
    `where=${encodeURIComponent(JSON.stringify({ id: { in: recordIds } }))}`,
    // The page has to hold the whole batch. `ids=` used to size the page from
    // the list itself; a `where` clause does not, so an unnamed `limit` would
    // take the route's default — 50 in the cloud — and silently answer half of
    // a 100-record batch as though the rest had no renditions.
    `limit=${recordIds.length}`,
    "include=metadata",
  ];
  const upstream = await authorized.fetch(`/data/records?${params.join("&")}`);
  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const body = (await upstream.json()) as { records: UpstreamRecord[] };
  const records = new Map(body.records.map((record) => [record.id, record]));
  // The rungs, their URLs and whether this node holds the bytes — Photos' own
  // table and Photos' own file plane, which is where a rendition lives now. The
  // shared page above carries the source dimensions the ladder is measured
  // against and nothing else about a rendition.
  const renditions = await loadHydratedRenditions(authorized.fetch, [...records.keys()]);
  const expiresAt = new Date(Date.now() + URL_LIFETIME_SECONDS * 1000).toISOString();
  const policies = currentRenditionPolicies();
  const cloud = process.env.STARKEEP_APP_CLIENT_MODE === "cloud";
  const localVerdicts = cloud ? null : await loadLocalVerdicts();
  const seen = new Set<string>();
  const results: unknown[] = [];

  for (const request of parsed.requests) {
    const record = records.get(request.recordId);
    if (!record) {
      const missingKey = `${request.recordId}:missing`;
      if (!seen.has(missingKey)) {
        seen.add(missingKey);
        results.push({ recordId: request.recordId, status: "missing" });
      }
      continue;
    }
    const kind = mediaKind(record);
    const policy = policies[kind];
    const targetLongEdge = canonicalTarget(policy, request.requiredLongEdge);
    const key = `${record.id}:${policy.version}:${targetLongEdge}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rungs: readonly HydratedRendition[] = renditions.get(record.id) ?? [];
    const rawDecision = kind === "video"
      ? resolveVideo(rungs, [targetLongEdge], cloud)[String(targetLongEdge)] ?? {}
      : resolveFor(record, rungs, [targetLongEdge], cloud, localVerdicts)[String(targetLongEdge)];
    const decision = kind === "still"
      ? attachStillUrlLifetime(rawDecision as ReturnType<typeof resolveFor>[string], expiresAt)
      : rawDecision;
    results.push({
      recordId: record.id,
      status: "resolved",
      mediaKind: kind,
      policyVersion: policy.version,
      canonicalTargetLongEdge: targetLongEdge,
      effectiveCoverage: coverage(policy, targetLongEdge),
      decision,
    });
  }

  // The measurement the browser arrived at, alongside the rung it resolved to.
  // Sizing faults in the viewer and the grid are invisible from the response
  // alone — a correct 2560 answer to an overstated requirement reads exactly
  // like an incorrect one — so the requirement that produced it is logged too.
  console.log(
    `[photos-renditions] ${parsed.requests
      .map((request) => `${request.recordId}:${request.requiredLongEdge}->${request.targetLongEdge}`)
      .join(" ")}`,
  );

  return withRefreshedSession(
    Response.json({ policies, results }),
    authorized.refreshedCookie,
  );
}
