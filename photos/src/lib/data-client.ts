import { fetchRuntimeConfig } from "./runtime-config";
import { readCloudConfig } from "./cloud-config";
import { refreshTokens } from "./cognito-auth";

/**
 * Which data server this build talks to. Decided once at boot from runtime
 * config: if apiGatewayUrl is set the build is paired with the cloud data
 * server; otherwise it talks to the local data server through the
 * same-origin /api/local-data proxy (which resolves the loopback URL
 * server-side from $STARKEEP_DATA_DIR/app-creds/photos.json).
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

export async function resolveDataSource(): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  const target = await getDataTarget();
  if (target.kind === "remote") {
    // Try to get an auth token (requires the user to be signed in).
    // If not available yet, still use the remote URL — the API will 401
    // rather than the app falling back to localhost.
    const config = await readCloudConfig();
    const token = config ? await getAccessToken().catch(() => null) : null;
    if (!token) console.warn("[data-client] Remote target, no auth token — request will be unauthenticated");
    // Cloud data server routes are all under /apps/{appId}/... — the
    // Lambda's $default integration 404s anything that doesn't match
    // parseAppPath. Local target goes through /api/local-data which
    // already scopes by appId via HMAC, so the prefix is remote-only.
    return {
      baseUrl: `${target.apiGatewayUrl.replace(/\/$/, "")}/apps/photos`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  }
  // Local target: the browser hits the photos app's own server-side proxy,
  // which adds X-Starkeep-App-Id + HMAC headers using the secret persisted
  // at install time. Same-origin → no CORS. The data-server URL itself
  // (127.0.0.1:9820 by default) is read server-side by @starkeep/app-client
  // from $STARKEEP_DATA_DIR/app-creds/photos.json.
  return { baseUrl: "/api/local-data", headers: {} };
}
