import { fetchRuntimeConfig } from "./runtime-config";
import { readCloudConfig } from "./cloud-config";
import { refreshTokens } from "./cognito-auth";
import { withBasePath } from "./base-path";

/**
 * Where this build runs. Decided once at boot from runtime config: if
 * apiGatewayUrl is set the build is cloud-served (SPA mounted under
 * /apps/photos on the API Gateway domain); otherwise it is served locally by
 * the Next.js dev/standalone server.
 *
 * NOTE: this is NOT the data-plane target. Data-plane calls always route
 * through the same-origin /api/local-data proxy (see resolveDataSource) which
 * signs server-side. `getDataTarget` is only for the app's OWN, JWT-gated
 * API routes that the browser calls directly on the gateway (e.g. /api/resize
 * — see resolveAppApiSource).
 */
export type DataTarget =
  | { kind: "local" }
  | { kind: "remote"; apiGatewayUrl: string };

let targetPromise: Promise<DataTarget> | null = null;

async function resolveTarget(): Promise<DataTarget> {
  const rc = await fetchRuntimeConfig();
  if (rc?.apiGatewayUrl) {
    return { kind: "remote", apiGatewayUrl: rc.apiGatewayUrl };
  }
  return { kind: "local" };
}

export function getDataTarget(): Promise<DataTarget> {
  if (!targetPromise) targetPromise = resolveTarget();
  return targetPromise;
}

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  const config = await readCloudConfig();
  if (!config?.cognitoConfig || !config.cognitoRefreshToken) {
    console.warn("[data-client] No Cognito config or refresh token in cloud config");
    return null;
  }
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    console.debug("[data-client] Using cached access token (expires in", Math.round((tokenCache.expiresAt - now) / 1000), "s)");
    return tokenCache.accessToken;
  }
  console.debug("[data-client] Refreshing access token via Cognito...");
  try {
    const tokens = await refreshTokens(config.cognitoConfig, config.cognitoRefreshToken);
    tokenCache = { accessToken: tokens.accessToken, expiresAt: now + tokens.expiresIn * 1000 };
    console.debug("[data-client] Access token refreshed, expires in", tokens.expiresIn, "s");
    return tokenCache.accessToken;
  } catch (err) {
    console.error("[data-client] Token refresh failed:", err);
    throw err;
  }
}

/**
 * Data-plane source resolution for the Photos browser client.
 *
 * The browser NEVER talks to a data server directly. Every data-plane call is
 * routed through this app's same-origin Next.js proxy at `/api/local-data`
 * (app/api/local-data/[...path]/route.ts), which HMAC-signs the request
 * server-side with the photos app credential and forwards it to the data
 * server. This holds in BOTH deployment modes, and the local-vs-cloud choice
 * is made entirely server-side by @starkeep/app-client's credential loader —
 * the browser is oblivious to it:
 *
 *   - local: the loader reads the creds file written by admin-web at install
 *     time and forwards to the loopback local-data-server (127.0.0.1:9820).
 *   - cloud: the app Lambda runs with STARKEEP_APP_CLIENT_MODE=cloud, so the
 *     loader fetches the HMAC secret from SSM and forwards to the cloud data
 *     server's API Gateway (.../apps/photos).
 *
 * Signing must happen in the proxy and not here because (a) the HMAC secret
 * must never reach the browser, and (b) the cloud data server's data plane is
 * HMAC-only — it identifies the *app*, not the end user, and does not accept
 * end-user Cognito tokens (see cloud-data-server-program.ts). End-user
 * sign-in is a separate app-level concern handled by the AuthGate.
 */
export async function resolveDataSource(): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  // Same-origin proxy path. In the cloud the SPA is mounted under
  // /apps/photos, and a raw absolute path like "/api/local-data" bypasses the
  // app (404 at the gateway), so it must carry the basePath prefix. In local
  // dev BASE_PATH is empty and this is a no-op.
  return { baseUrl: withBasePath("/api/local-data"), headers: {} };
}

/**
 * Source for the app's OWN API routes that the browser calls directly (not the
 * data plane) — currently just /api/resize, backed by the JWT-gated `api`
 * Lambda handler. Unlike the data plane these are gated by the gateway's
 * Cognito JWT authorizer, so the browser sends its bearer token directly.
 *
 *   - remote: base is the gateway URL under /apps/photos (the SPA is mounted
 *     there, but absolute-path fetches wouldn't carry the prefix), plus the
 *     Cognito bearer token.
 *   - local: same-origin, no auth — the Next.js server serves /api/* directly.
 */
export async function resolveAppApiSource(): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  const target = await getDataTarget();
  if (target.kind === "remote") {
    const config = await readCloudConfig();
    const token = config ? await getAccessToken().catch(() => null) : null;
    if (!token) console.warn("[data-client] Remote target, no auth token — /api/* request will be unauthenticated");
    return {
      baseUrl: `${target.apiGatewayUrl.replace(/\/$/, "")}/apps/photos`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  }
  return { baseUrl: "", headers: {} };
}
