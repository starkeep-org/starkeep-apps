import { type NextRequest, NextResponse } from "next/server";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { readVisionConfig } from "@/vision/config";
import { remoteNotImplemented } from "@/vision/remote";
import {
  emptyTagEdits,
  parseTagEdits,
  serializeTagEdits,
  tagsForRecord,
  type TagEdits,
} from "@/vision/tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TAG_LENGTH = 60;
const MAX_EDITS = 100;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET/PUT /api/vision/tags/[id] — one photo's tags.
 *
 * **Reads two different stores and says so.** The suggestions come from local,
 * never-synced vision state (the scene embedding × the vocabulary's text
 * embeddings); the edits come from `image_enriched`, which *does* sync. §7 draws
 * that line deliberately: derived bytes are app-owned and reproducible, and what a
 * human authored is not.
 *
 * PUT takes the whole diff rather than a "toggle this tag" verb. Two reasons: the
 * diff is the unit that syncs, so a partial update would need a read-modify-write
 * here *and* an LWW resolution there; and a client that has just rendered the tags
 * already knows the whole intended state.
 *
 * The route is under `/api/vision/` and inherits `remoteNotImplemented()` even
 * though half its data is syncable, because the *suggestions* are local-only —
 * there is nothing useful to serve from a cloud deployment.
 */
export async function GET(_req: NextRequest, ctx: RouteContext): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const { id } = await ctx.params;
  const config = readVisionConfig();
  const edits = await readEdits(id);
  if (edits === null) {
    return NextResponse.json(
      { error: "photos has not been installed locally — run install from admin-web first" },
      { status: 503 },
    );
  }

  const derived = tagsForRecord(id, edits, config.tags.vocabulary, config.tags.threshold);
  if (!derived) {
    // No scene embedding, or no tag embeddings for this vocabulary. The user's own
    // tags still exist and are still the authoritative half, so they are returned
    // regardless — a photo the scan has not reached must not look untagged.
    return NextResponse.json({
      described: false,
      tags: edits.added.map((tag) => ({ tag, source: "added" as const, score: null })),
      suggestions: [],
      edits,
    });
  }

  return NextResponse.json({ described: true, ...derived, edits });
}

export async function PUT(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { added?: unknown; removed?: unknown }
    | null;
  if (!body) return NextResponse.json({ error: "a JSON body is required" }, { status: 400 });

  const added = sanitize(body.added);
  const removed = sanitize(body.removed);
  if (added === null || removed === null) {
    return NextResponse.json(
      { error: `added and removed must be arrays of ≤ ${MAX_TAG_LENGTH}-char strings` },
      { status: 400 },
    );
  }
  // A tag in both lists is contradictory, and silently picking one would make the
  // UI's next read disagree with what it just sent.
  const conflict = added.find((tag) => removed.includes(tag));
  if (conflict) {
    return NextResponse.json(
      { error: `"${conflict}" cannot be both added and removed` },
      { status: 400 },
    );
  }

  const creds = await loadAppCredentials("photos");
  if (!creds) {
    return NextResponse.json(
      { error: "photos has not been installed locally — run install from admin-web first" },
      { status: 503 },
    );
  }

  const edits: TagEdits = { added, removed };
  // A partial upsert, like captions: the platform injects a fresh `updated_at` so
  // LWW fires, and the ON CONFLICT SET clause covers only the columns present — so
  // caption, title, and date_taken_override survive untouched.
  const res = await signedFetch(creds, "/app-data/db/image_enriched", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row: { record_id: id, tag_edits: serializeTagEdits(edits) } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json({ error: detail || "failed to save tags" }, { status: 502 });
  }

  const config = readVisionConfig();
  const derived = tagsForRecord(id, edits, config.tags.vocabulary, config.tags.threshold);
  return NextResponse.json({
    described: derived !== null,
    tags: derived?.tags ?? added.map((tag) => ({ tag, source: "added" as const, score: null })),
    suggestions: derived?.suggestions ?? [],
    edits,
  });
}

/** `null` means "not installed"; an absent row is an empty diff, not an error. */
async function readEdits(recordId: string): Promise<TagEdits | null> {
  const creds = await loadAppCredentials("photos");
  if (!creds) return null;
  const q = new URLSearchParams({ record_id: recordId });
  const res = await signedFetch(creds, `/app-data/db/image_enriched?${q.toString()}`);
  if (!res.ok) return emptyTagEdits();
  const { rows } = (await res.json()) as { rows?: Array<{ tag_edits?: unknown }> };
  return parseTagEdits(rows?.[0]?.tag_edits);
}

function sanitize(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LENGTH) return null;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out.slice(0, MAX_EDITS);
}
