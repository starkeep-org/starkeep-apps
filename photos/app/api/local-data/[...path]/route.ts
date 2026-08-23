import { createNextProxyHandler } from "@starkeep/app-client";

/**
 * Server-side proxy to the data server. The browser hits us at
 * `/api/local-data/...` and we forward to the configured data-server with the
 * photos app's HMAC signature. The HMAC secret is loaded by @starkeep/app-client
 * from `$STARKEEP_DATA_DIR/app-creds/photos.json` (written by admin-web at
 * install time, mode 0600, never sent to the browser).
 *
 * Despite the name, this is the cloud data path too: `resolveDataSource()`
 * returns this same mount on both surfaces, and @starkeep/app-client decides
 * server-side whether to forward to the loopback local-data-server or to the
 * cloud broker.
 */
const handler = createNextProxyHandler({
  appId: "photos",
  // KNOWN GAP, deliberately recorded rather than defaulted away. Photos has no
  // server-side notion of an end user: `AuthGate` runs in the browser and only
  // decides what to render, so in a cloud install this proxy signs with the
  // Photos HMAC credential for whoever asks — the entire library, reads and
  // writes, plus CloudFront-signed image URLs minted inline in list responses.
  //
  // The fix is the session layer in plan-cloud-app-auth-and-runtime-2026-08-22
  // §3; when it lands this becomes
  // `{ auth: "session", verifySession: requireSession }` and the tier-3
  // negative test in e2e-aws goes green. Until then Photos must not be
  // installed to the cloud — see photos-unauthenticated-exposure-2026-08-23.
  endUserAuth: {
    auth: "anonymous",
    justification:
      "Not justifiable — this is the open hole from the 2026-08-23 exposure, " +
      "recorded here rather than hidden. Closes with the session layer in " +
      "plan-cloud-app-auth-and-runtime-2026-08-22 §3; Photos must not be cloud-installed first.",
  },
});

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
