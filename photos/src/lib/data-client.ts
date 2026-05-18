import { fetchRuntimeConfig } from "./runtime-config";
import { readCloudConfig } from "./cloud-config";
import { refreshTokens } from "./cognito-auth";

export type DataSourceMode = "local" | "remote";

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

export async function resolveDataSource(mode: DataSourceMode): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
}> {
  if (mode === "remote") {
    const runtimeConfig = await fetchRuntimeConfig();
    const apiGatewayUrl = runtimeConfig?.apiGatewayUrl;
    if (apiGatewayUrl) {
      // Try to get an auth token (requires the user to be signed in).
      // If not available yet, still use the remote URL — the API will 401
      // rather than the app falling back to localhost.
      const config = await readCloudConfig();
      const token = config ? await getAccessToken().catch(() => null) : null;
      if (!token) console.warn("[data-client] Remote mode, no auth token — request will be unauthenticated");
      return {
        baseUrl: apiGatewayUrl.replace(/\/$/, ""),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      };
    }
    console.warn("[data-client] Remote mode but no apiGatewayUrl in runtime config — falling back to local");
  }
  // In local mode the browser hits the photos app's own server-side proxy,
  // which adds X-Starkeep-App-Id + HMAC headers using the secret persisted
  // at install time. Same-origin → no CORS. The data-server URL itself
  // (127.0.0.1:9820 by default) is read server-side from .starkeep-local.json.
  return { baseUrl: "/api/local-data", headers: {} };
}
