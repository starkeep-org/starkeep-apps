import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { precheckThumbnail, PHOTOS_LABEL_KEYS, THUMBNAIL_SIZE_CLASS } from "@/photos-lib";

export const runtime = "nodejs";

/**
 * POST /api/resize
 * Generates a thumbnail DataRecord for an original image. Bytes are uploaded
 * via presigned S3 PUT and the record is registered by content hash — same
 * shape as the canonical add-photo flow (addPhotoFromPath in
 * data-server-client.ts). All HMAC-signed with the photos app's installed
 * credentials.
 */

function dataRecordObjectKey(typeId: string, contentHash: string): string {
  return `shared/${typeId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

export async function POST(req: NextRequest) {
  const creds = await loadAppCredentials("photos");
  if (!creds) {
    return NextResponse.json(
      { error: "photos has not been installed locally — run install from admin-web first" },
      { status: 503 },
    );
  }

  const { targetId } = await req.json() as { targetId?: string };

  if (!targetId) {
    return NextResponse.json({ error: "targetId is required" }, { status: 400 });
  }
  console.log(`[resize] start targetId=${targetId} appId=${creds.appId}`);

  // Fetch the source record
  const recordRes = await signedFetch(creds, `/data/records/${targetId}`);
  if (!recordRes.ok) {
    const errBody = await recordRes.text().catch(() => "");
    console.error(`[resize] GET /data/records/${targetId} → ${recordRes.status}: ${errBody}`);
    return NextResponse.json(
      { error: `Record fetch failed: ${recordRes.status} ${errBody}` },
      { status: recordRes.status === 404 ? 404 : 502 },
    );
  }
  const { record } = await recordRes.json() as { record: {
    id: string;
    object_storage_key: string | null;
    parent_id: string | null;
    mime_type: string | null;
    original_filename: string | null;
  } };

  if (!record.object_storage_key) {
    return NextResponse.json({ error: "Record has no attached file" }, { status: 422 });
  }

  // May this record be derived *from*? A rendition may not — that would
  // recurse. A crop may: it is a user artifact that needs its own tile, and
  // rejecting every record with a parent left crops with no thumbnail and
  // therefore invisible.
  //
  // There is deliberately no "already has one, stop" check any more. With a
  // ladder, one existing rung says nothing about the others, and the old early
  // return would have frozen every record at whatever it happened to have.
  // Which rungs to skip is decided per rung, below.
  const precheck = await precheckThumbnail(targetId, (p) => signedFetch(creds, p));
  if (precheck.alreadyThumbnail) {
    return NextResponse.json({ error: "Record is already a rendition" }, { status: 400 });
  }

  // Fetch the source image file
  const fileUrlRes = await signedFetch(creds, `/data/records/${targetId}/file-url`);
  if (!fileUrlRes.ok) {
    const errBody = await fileUrlRes.text().catch(() => "");
    console.error(`[resize] file-url ${targetId} → ${fileUrlRes.status}: ${errBody}`);
    return NextResponse.json({ error: `file-url failed: ${fileUrlRes.status} ${errBody}` }, { status: 502 });
  }
  const { url: sourceUrl } = await fileUrlRes.json() as { url: string };

  // The file-url endpoint returns a self-signed token URL that doesn't need HMAC.
  const sourceRes = await fetch(sourceUrl);
  if (!sourceRes.ok) {
    const errBody = await sourceRes.text().catch(() => "");
    console.error(`[resize] source fetch ${sourceUrl} → ${sourceRes.status}: ${errBody.slice(0, 300)}`);
    return NextResponse.json({ error: `source fetch failed: ${sourceRes.status}` }, { status: 502 });
  }
  const inputBuffer = Buffer.from(await sourceRes.arrayBuffer());

  // Derive every applicable rung from one decode, not just a thumbnail.
  //
  // Which rungs apply is a function of the source's long edge (a class never
  // upscales), so a small original produces fewer of them and a large one
  // produces the whole ladder. Decoding once and encoding N times is the point:
  // decoding a 48 MP source is the expensive part, and doing it per rung would
  // multiply it for output that is collectively smaller than the source.
  const { deriveStillLadder, computeThumbHash, readSourceDimensions } = await import(
    "@/photos-lib/image-processing/derive-ladder"
  );
  const { publishRendition, existingRenditionClasses, publishThumbHash, assertLadderComplete } =
    await import("@/photos-lib/image-processing/publish-renditions");
  const { ladderIsComplete } = await import("@/photos-lib/image-processing/derive-ladder");

  let derived;
  try {
    derived = await deriveStillLadder(inputBuffer);
  } catch (err) {
    // A format this node cannot decode. Reported distinctly from a transient
    // failure so a sweeper can record "undecodable here" once instead of
    // retrying the same file every day forever.
    console.error(`[resize] decode failed for ${targetId}: ${(err as Error).message}`);
    return NextResponse.json(
      { error: "undecodable-here", detail: (err as Error).message },
      { status: 422 },
    );
  }

  // Skip rungs that already exist — the route is re-runnable, and a retry after
  // a partial failure should finish the job rather than duplicate it.
  const already = new Set(await existingRenditionClasses((p, i) => signedFetch(creds, p, i), targetId));
  const published = [];
  for (const rendition of derived) {
    if (already.has(rendition.sizeClass)) continue;
    const contentHash = createHash("sha256").update(rendition.data).digest("hex");
    const objectStorageKey = dataRecordObjectKey("image", contentHash);
    try {
      published.push(
        await publishRendition(
          (p, i) => signedFetch(creds, p, i),
          { id: targetId, originalFilename: record.original_filename },
          rendition,
          contentHash,
          objectStorageKey,
        ),
      );
    } catch (err) {
      // Partial success is the honest outcome: the rungs already published are
      // real and useful, and re-running finishes the rest. Failing the whole
      // request would throw away work that succeeded.
      console.error(`[resize] ${(err as Error).message}`);
      return NextResponse.json(
        { ok: false, published, error: (err as Error).message },
        { status: 502 },
      );
    }
  }

  // Stage zero of progressive presentation, written on the *parent*: a ~25-byte
  // placeholder the grid paints before fetching any image bytes at all.
  try {
    await publishThumbHash(
      (p2, i) => signedFetch(creds, p2, i),
      targetId,
      await computeThumbHash(inputBuffer),
    );
  } catch (err) {
    // Best-effort by design: a missing placeholder is a grey tile for a few
    // hundred milliseconds, not a broken record.
    console.warn(`[resize] thumb_hash failed for ${targetId}: ${(err as Error).message}`);
  }

  // The archive gate. Only asserted when every applicable rung actually
  // exists — the point of the split is that the platform trusts this claim, so
  // making it loosely would be the one way an app could freeze an original
  // that has nothing readable in its place.
  const finalClasses = await existingRenditionClasses((p2, i) => signedFetch(creds, p2, i), targetId);
  const sourceDims = await readSourceDimensions(inputBuffer);
  let archiveGate: { tagged: boolean; refusals: string[] } | null = null;
  if (ladderIsComplete(sourceDims.longEdge, finalClasses)) {
    archiveGate = await assertLadderComplete((p2, i) => signedFetch(creds, p2, i), targetId);
  }

  return NextResponse.json({ ok: true, published, archiveGate });
}
