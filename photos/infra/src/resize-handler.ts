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
import { resizeForThumbnail } from "../../src/photos-lib/image-processing/resize.js";
import {
  precheckThumbnail,
  PHOTOS_LABEL_KEYS,
} from "../../src/photos-lib/labels.js";
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
    const precheck = await precheckThumbnail(targetId, (p) => signedFetch(creds, p));
    if (precheck.alreadyThumbnail) {
      return clientErr("Record is already a thumbnail", 400);
    }
    if (precheck.existingThumbnailId) {
      return ok({ ok: true, thumbnailId: precheck.existingThumbnailId, skipped: true });
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

    const MAX_WIDTH = 400;
    const resizeResult = await resizeForThumbnail(inputBuffer, MAX_WIDTH);
    const resizedBytes = new Uint8Array(resizeResult.data);

    // Upload via presigned S3 PUT, then register by content hash — same flow
    // as POST /api/photos. The inline form 413s on real photo bytes once the
    // request rides through API Gateway.
    const contentHash = createHash("sha256").update(resizedBytes).digest("hex");
    const objectStorageKey = dataRecordObjectKey("image", contentHash);

    const presignRes = await signedFetch(creds, `/files/presign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: objectStorageKey, contentType: resizeResult.contentType }),
    });
    if (!presignRes.ok) {
      const errBody = await presignRes.text().catch(() => "");
      console.error(`[resize] presign → ${presignRes.status}: ${errBody}`);
      return clientErr(`presign failed: ${presignRes.status}`, 502);
    }
    const { url: uploadUrl } = (await presignRes.json()) as { url: string };

    const s3Res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": resizeResult.contentType },
      body: resizedBytes,
    });
    if (!s3Res.ok) {
      console.error(`[resize] S3 PUT → ${s3Res.status} ${s3Res.statusText}`);
      return clientErr(`S3 PUT failed: ${s3Res.status}`, 502);
    }

    // Create the thumbnail DataRecord — key-ref form, links to source via parentId.
    const createRes = await signedFetch(creds, `/data/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // The thumbnail is re-encoded as JPEG above, so its type is image/jpeg.
        type: "image/jpeg",
        fileName: `thumb_${record.original_filename ?? "image"}`,
        contentType: resizeResult.contentType,
        contentHash,
        sizeBytes: resizedBytes.byteLength,
        parentId: targetId,
        // Types the parent edge. `parent_id` says *which* record this came
        // from; this says *how*, which the column alone cannot express — and
        // without it a crop is indistinguishable from a thumbnail.
        //
        // Doubles as the interest marker for other image-declaring apps:
        // a thumbnail is derived, not something the user uploaded.
        // The `photos/` namespace comes from our authenticated identity, so
        // no prefix is sent. Originals stay unlabelled.
        labels: [{ key: PHOTOS_LABEL_KEYS.thumbnail }],
      }),
    });
    if (!createRes.ok) {
      const errBody = await createRes.text().catch(() => "");
      console.error(`[resize] create thumb → ${createRes.status}: ${errBody}`);
      return clientErr(`Failed to create thumbnail: ${errBody}`, 502);
    }
    const { record: thumbnailRecord } = (await createRes.json()) as { record: { id: string } };

    // Write image dimensions into shared metadata. Non-fatal.
    const metaRes = await signedFetch(creds, `/data/records/${thumbnailRecord.id}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        typeId: "image",
        metadata: { width: resizeResult.width ?? 0, height: resizeResult.height ?? 0 },
      }),
    });
    if (!metaRes.ok) {
      const errBody = await metaRes.text().catch(() => "");
      console.warn(`[resize] metadata write failed (non-fatal): ${metaRes.status} ${errBody}`);
    }

    return ok({ ok: true, thumbnailId: thumbnailRecord.id });
  } catch (e) {
    console.error("[resize] handler error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
