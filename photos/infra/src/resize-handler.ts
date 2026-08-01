/**
 * Photos cloud resize Lambda — generates thumbnail DataRecords for originals.
 *
 * Mirrors the local Next.js /api/resize route: takes a targetId, fetches the
 * source record and its bytes via the cloud-data-server broker, runs sharp to
 * resize, then POSTs a new DataRecord with parentId set.
 *
 * Identity to the broker is per-app HMAC via @starkeep/app-client (cloud mode):
 * the Lambda loads its HMAC secret from SSM via its exec role, then signs each
 * call to /apps/photos/* with X-Starkeep-App-Id + X-Starkeep-App-Sig. The
 * broker verifies the signature, assumes the photos app role, and runs the
 * per-extension grant checks. End-user JWTs are no longer forwarded; the data
 * plane identifies the app, not the user.
 */

import { createHash } from "node:crypto";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import { deriveStillLadder } from "../../src/photos-lib/image-processing/derive-ladder.js";
import {
  publishRendition,
  existingRenditionClasses,
} from "../../src/photos-lib/image-processing/publish-renditions.js";
import { precheckThumbnail } from "../../src/photos-lib/labels.js";
import { ok, clientErr, type APIGatewayEvent } from "./handler-utils.js";

function dataRecordObjectKey(typeId: string, contentHash: string): string {
  return `shared/${typeId}/${contentHash.slice(0, 2)}/${contentHash}`;
}

interface BrokerPhotoRecord {
  id: string;
  object_storage_key: string | null;
  parent_id: string | null;
  mime_type: string | null;
  original_filename: string | null;
}

export async function handler(event: APIGatewayEvent) {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;

    if (method === "OPTIONS") {
      return { statusCode: 200, body: "" };
    }

    // API Gateway routes are mounted under /apps/photos/...; the lambda
    // sees the prefixed path. POST /api/resize is the only path this handler
    // serves.
    if (!(method === "POST" && path.endsWith("/api/resize"))) {
      return clientErr("Not found", 404);
    }

    const rawBody = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, "base64").toString("utf8")
      : (event.body ?? "{}");
    const body = JSON.parse(rawBody) as { targetId?: string };
    if (!body.targetId) return clientErr("targetId is required", 400);
    const targetId = body.targetId;
    console.log(`[resize] start targetId=${targetId}`);

    const creds = await loadAppCredentials("photos");
    if (!creds) {
      return clientErr("photos credentials not available in cloud", 503);
    }

    // Fetch the source record.
    const recordRes = await signedFetch(creds, `/data/records/${targetId}`);
    if (!recordRes.ok) {
      const errBody = await recordRes.text().catch(() => "");
      console.error(`[resize] GET record ${targetId} → ${recordRes.status}: ${errBody}`);
      return clientErr(
        `Record fetch failed: ${recordRes.status}`,
        recordRes.status === 404 ? 404 : 502,
      );
    }
    const { record } = (await recordRes.json()) as { record: BrokerPhotoRecord };

    if (!record.object_storage_key) return clientErr("Record has no attached file", 422);
    // Two targeted queries, not a scan of the library. Both questions used to
    // be answered by listing every readable record and filtering client-side,
    // which was O(library) — and wrong above the page limit, since a record
    // outside the first 1000 read as "no thumbnail yet" and got one derived
    // again. The rules live in photos-lib, shared with the Next /api/resize
    // route this handler mirrors line for line: a rule kept in both would
    // eventually be fixed in only one.
    // May this record be derived *from*? A rendition may not — that would
    // recurse. A crop may: it is a user artifact that needs its own tile.
    //
    // There is deliberately no "already has one, stop" check any more. With a
    // ladder, one existing rung says nothing about the others, and the old
    // early return would have frozen every record at whatever it happened to
    // have. Which rungs to skip is decided per rung, below.
    const precheck = await precheckThumbnail(targetId, (p) => signedFetch(creds, p));
    if (precheck.alreadyThumbnail) {
      return clientErr("Record is already a rendition", 400);
    }

    // Presigned URL for the source file — direct S3 fetch, no broker hop for
    // the byte transfer.
    const fileUrlRes = await signedFetch(creds, `/data/records/${targetId}/file-url`);
    if (!fileUrlRes.ok) {
      const errBody = await fileUrlRes.text().catch(() => "");
      console.error(`[resize] file-url ${targetId} → ${fileUrlRes.status}: ${errBody}`);
      return clientErr(`file-url failed: ${fileUrlRes.status}`, 502);
    }
    const { url: sourceUrl } = (await fileUrlRes.json()) as { url: string };

    const sourceRes = await fetch(sourceUrl);
    if (!sourceRes.ok) {
      const errBody = await sourceRes.text().catch(() => "");
      console.error(`[resize] source fetch → ${sourceRes.status}: ${errBody.slice(0, 300)}`);
      return clientErr(`source fetch failed: ${sourceRes.status}`, 502);
    }
    const inputBuffer = Buffer.from(await sourceRes.arrayBuffer());

    // Derive every applicable rung from one decode, not just a thumbnail.
    // Which rungs apply is a function of the source's long edge, so a small
    // original produces fewer and a large one produces the whole ladder.
    let derived;
    try {
      derived = await deriveStillLadder(inputBuffer);
    } catch (err) {
      // A format this node cannot decode. The cloud fallback covers JPEG, PNG,
      // WebP and AVIF only — the custom libvips build that would add HEIC and
      // raw is rejected for now — so this is an expected outcome for a
      // phone-captured library, not an anomaly. Reported distinctly from a
      // transient failure so a sweeper records "undecodable here" once instead
      // of retrying the same file every day forever.
      console.error(`[resize] decode failed for ${targetId}: ${(err as Error).message}`);
      return clientErr(`undecodable-here: ${(err as Error).message}`, 422);
    }

    // Skip rungs that already exist: this handler is re-runnable, and a retry
    // after a partial failure should finish the job rather than duplicate it.
    const already = new Set(
      await existingRenditionClasses((p, i) => signedFetch(creds, p, i), targetId),
    );
    const published: Array<{ sizeClass: string; recordId: string }> = [];
    for (const rendition of derived) {
      if (already.has(rendition.sizeClass)) continue;
      const contentHash = createHash("sha256").update(rendition.data).digest("hex");
      const objectStorageKey = dataRecordObjectKey("image", contentHash);
      try {
        const result = await publishRendition(
          (p, i) => signedFetch(creds, p, i),
          { id: targetId, originalFilename: record.original_filename },
          rendition,
          contentHash,
          objectStorageKey,
        );
        published.push({ sizeClass: result.sizeClass, recordId: result.recordId });
      } catch (err) {
        // Partial success is the honest outcome: the rungs already published
        // are real and useful, and re-running finishes the rest.
        console.error(`[resize] ${(err as Error).message}`);
        return clientErr((err as Error).message, 502);
      }
    }

    // Dimensions are written per rendition inside publishRendition, not here:
    // variant resolution orders by long edge, so a rendition without them is
    // excluded from resolution entirely and becomes storage nobody reads.

    // The archive gate, asserted only when every applicable rung actually
    // exists. The platform trusts this claim — that is the point of the split —
    // so making it loosely is the one way an app could freeze an original with
    // nothing readable in its place.
    const finalClasses = await existingRenditionClasses(
      (p, i) => signedFetch(creds, p, i),
      targetId,
    );
    const sourceDims = await readSourceDimensions(inputBuffer);
    let archiveGate: { tagged: boolean; refusals: string[] } | null = null;
    if (ladderIsComplete(sourceDims.longEdge, finalClasses)) {
      archiveGate = await assertLadderComplete((p, i) => signedFetch(creds, p, i), targetId);
    }

    return ok({ ok: true, published, archiveGate });
  } catch (e) {
    console.error("[resize] handler error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
