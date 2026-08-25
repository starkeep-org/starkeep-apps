/**
 * Photos cloud resize Lambda — derives renditions for an original the cloud
 * holds, on demand, for a viewer looking at it.
 *
 * The derivation itself is `photos-lib`'s `deriveAndPublish`, the same code the
 * Next `/api/resize` route and the local worker run. This file is the HTTP
 * shape plus the one thing that is genuinely cloud-specific: a hard budget.
 *
 * Identity to the broker is per-app HMAC via @starkeep/app-client (cloud mode):
 * the Lambda loads its HMAC secret from SSM via its exec role, then signs each
 * call to /apps/photos/* with X-Starkeep-App-Id + X-Starkeep-App-Sig. The
 * broker verifies the signature, assumes the photos app role, and runs the
 * per-extension grant checks. End-user JWTs are no longer forwarded; the data
 * plane identifies the app, not the user.
 */

import { loadAppCredentials, signedFetch, USER_TOKEN_HEADER } from "@starkeep/app-client";
import { deriveAndPublish } from "../../src/photos-lib/image-processing/derive-and-publish.js";
import { CHEAP_TARGET_LONG_EDGE } from "../../src/photos-lib/ladder.js";
import { precheckThumbnail } from "../../src/photos-lib/labels.js";
import { ok, clientErr, type APIGatewayEvent } from "./handler-utils.js";

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
    const body = JSON.parse(rawBody) as { targetId?: string; targetLongEdge?: number };
    if (!body.targetId) return clientErr("targetId is required", 400);
    const targetId = body.targetId;
    // The pixel size the viewer needs. A caller that names none gets the cheap
    // tier rather than the whole ladder, which this handler cannot afford — see
    // the note by the call below.
    const requestedLongEdge =
      typeof body.targetLongEdge === "number" ? body.targetLongEdge : CHEAP_TARGET_LONG_EDGE;
    console.log(`[resize] start targetId=${targetId}`);

    const creds = await loadAppCredentials("photos");
    if (!creds) {
      return clientErr("photos credentials not available in cloud", 503);
    }

    // Every broker call below carries the end user this resize is being done
    // for, alongside the app signature. The data plane requires a credential
    // bound to a named person on every call and grants no exemption to app
    // compute — a resize is Photos acting on someone's photo, not on its own
    // behalf. The token is the Bearer the gateway's JWT authorizer already
    // verified to let this request in, so there is nothing new to obtain and
    // nothing new to fail.
    const bearer = event.headers?.authorization ?? event.headers?.Authorization ?? "";
    const userToken = bearer.replace(/^Bearer\s+/i, "");
    if (!userToken) {
      return clientErr("Missing Authorization bearer token", 401);
    }
    const call = (path: string, init?: Parameters<typeof signedFetch>[2]) =>
      signedFetch(creds, path, {
        ...init,
        headers: { ...(init?.headers ?? {}), [USER_TOKEN_HEADER]: userToken },
      });

    // Fetch the source record.
    const recordRes = await call(`/data/records/${targetId}`);
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
    if ((record.mime_type ?? "").startsWith("video/")) {
      return clientErr("Video renditions are generated only by a local Photos node", 422);
    }

    // May this record be derived *from*? A rendition may not — that would
    // recurse. A crop may: it is a user artifact that needs its own tile. This
    // is one targeted query rather than a scan of the library, which is what it
    // used to be — and which was also wrong above the page limit, since a
    // record outside the first thousand read as "no thumbnail yet" and got one
    // derived again.
    const precheck = await precheckThumbnail(targetId, (p) => call(p));
    if (precheck.alreadyThumbnail) {
      return clientErr("Record is already a rendition", 400);
    }

    // Everything from here is `photos-lib`, shared with the Next
    // `/api/resize` route and the local derivation worker. The two used to be
    // line-for-line copies of a four-step publish flow, which is the shape of
    // duplication that gets fixed in one place and not the other.
    //
    // What the cloud supplies that the others do not: a narrowed class set. The
    // resize function has 512 MB — roughly a third of a vCPU, since Lambda
    // scales CPU with memory — and thirty seconds. The full ladder is about
    // 8.5 s of encode on eight cores, so it does not fit, and a handler that
    // attempts it times out having done and discarded all of it. So the cloud
    // derives what the viewer asked for plus the rungs the decode makes free,
    // and the expensive ones stay the owning node's work.
    //
    // No platform decoder and no attempt store: this node has neither a HEIC
    // decoder nor durable local disk. A HEIC record fails here every time, and
    // that is the accepted asymmetry — such a record stays ladder-incomplete,
    // is therefore never archived, and is derived by the laptop when it next
    // reaches it.
    const result = await deriveAndPublish({
      signedFetch: (p, i) => call(p, i),
      parent: {
        id: record.id,
        originalFilename: record.original_filename,
        mimeType: record.mime_type,
      },
      loadSource: async () => {
        const fileUrlRes = await call(`/data/records/${targetId}/file-url`);
        if (!fileUrlRes.ok) throw new Error(`file-url failed: ${fileUrlRes.status}`);
        const { url } = (await fileUrlRes.json()) as { url: string };
        const sourceRes = await fetch(url);
        if (!sourceRes.ok) throw new Error(`source fetch failed: ${sourceRes.status}`);
        return new Uint8Array(await sourceRes.arrayBuffer());
      },
      targetLongEdge: requestedLongEdge,
    });

    if (result.outcome === "undecodable-here") {
      // Expected for a phone-captured library rather than an anomaly: the cloud
      // fallback covers JPEG, PNG, WebP and AVIF only. Reported distinctly from
      // a transient failure so the caller records it once instead of retrying
      // the same file every day forever.
      console.error(`[resize] undecodable in cloud: ${targetId}: ${result.detail}`);
      return clientErr(`undecodable-here: ${result.detail}`, 422);
    }
    if (result.outcome === "publish-failed" || result.outcome === "transient-failure") {
      // Partial success is the honest outcome: the rungs already published are
      // real and useful, and re-running finishes the rest.
      console.error(`[resize] ${result.detail}`);
      return clientErr(result.detail ?? "derivation failed", 502);
    }

    return ok({
      ok: true,
      published: result.published,
      archiveGate: result.archiveGate,
    });
  } catch (e) {
    console.error("[resize] handler error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
