import { NextResponse, type NextRequest } from "next/server";
import { RENDITION_LABEL_REF } from "@/photos-lib/image-processing/publish-renditions";
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
} from "../library/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const MAX_RENDITION_BATCH_PAIRS = 100;
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

function attachStillUrlLifetime(
  decision: ReturnType<typeof resolveFor>[string],
  record: UpstreamRecord,
) {
  const lifetimeById = new Map(
    (record.variant_candidates ?? []).map((candidate) => [candidate.id, candidate.url_lifetime]),
  );
  const attach = <T extends { id?: string }>(entry: T): T & { urlLifetime?: unknown } => {
    const lifetime = entry.id ? lifetimeById.get(entry.id) : undefined;
    return lifetime ? { ...entry, urlLifetime: lifetime } : entry;
  };
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

export async function POST(req: NextRequest): Promise<Response> {
  const authorized = await authorizePhotosRoute(req);
  if (authorized instanceof Response) return authorized;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  const parsed = validateBody(raw);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const recordIds = [...new Set(parsed.requests.map((request) => request.recordId))].sort();
  const params = [
    `ids=${encodeURIComponent(recordIds.join(","))}`,
    "include=metadata",
    `variant=${encodeURIComponent(RENDITION_LABEL_REF)}`,
  ];
  const upstream = await authorized.fetch(`/data/records?${params.join("&")}`);
  if (!upstream.ok) {
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  const body = (await upstream.json()) as { records: UpstreamRecord[] };
  const records = new Map(body.records.map((record) => [record.id, record]));
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
    const rawDecision = kind === "video"
      ? resolveVideo(record, [targetLongEdge], cloud)[String(targetLongEdge)] ?? {}
      : resolveFor(record, [targetLongEdge], cloud, localVerdicts)[String(targetLongEdge)];
    const decision = kind === "still"
      ? attachStillUrlLifetime(rawDecision as ReturnType<typeof resolveFor>[string], record)
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
    NextResponse.json({ policies, results }),
    authorized.refreshedCookie,
  );
}
