import { createNextProxyHandler, sessionAuth } from "@starkeep/app-client";

/**
 * Server-side proxy to the data server. The browser hits us at
 * `/api/local-data/...` and we forward to the configured data server with the
 * photos app's HMAC signature. The HMAC secret is loaded by
 * @starkeep/app-client from `$STARKEEP_DATA_DIR/app-creds/photos.json`
 * (written by admin-web at install time, mode 0600, never sent to the
 * browser).
 *
 * Despite the name, this is the cloud data path too — @starkeep/app-client
 * decides server-side which data server the mount forwards to.
 */
const handler = createNextProxyHandler({
  appId: "photos",
  // The HMAC identifies Photos, not the person holding the browser, so this
  // mount would sign for whoever reached it. `sessionAuth()` is the platform's
  // cookie-session verifier, and it runs before the credential is loaded — a
  // rejected caller does not cause the secret to be read at all.
  //
  // Photos was worse than a plain data leak: list responses embed
  // CloudFront-signed rendition URLs inline, so one anonymous call handed out
  // working links to the image bytes as well as the metadata.
  //
  // Local mode stays open, which is the default: on the loopback surface the
  // browser, the data and the person are all on one machine, and a sign-in
  // gate in front of on-device data would break local-first.
  endUserAuth: sessionAuth(),
});

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
