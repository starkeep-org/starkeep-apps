import { createNextProxyHandler } from "@starkeep/app-client";

/**
 * Server-side proxy to the local-data-server. The browser hits us at
 * `/api/local-data/...` and we forward to the configured data-server with the
 * photos app's HMAC signature. The HMAC secret is loaded by @starkeep/app-client
 * from `$STARKEEP_DATA_DIR/app-creds/photos.json` (written by admin-web at
 * install time, mode 0600, never sent to the browser).
 */
const handler = createNextProxyHandler({ appId: "photos" });

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
