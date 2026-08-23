import { fetchRuntimeConfig } from "./runtime-config";
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

/**
 * A bearer token for the one call a cookie cannot serve — see
 * {@link resolveAppApiSource}.
 *
 * This used to read a refresh token out of localStorage and call Cognito from
 * the page. It now asks Photos' own server, which holds the refresh token in
 * an HttpOnly cookie and mints against it. What an XSS can steal here drops
 * from a credential good for months to one good for an hour.
 */
async function getAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.accessToken;

  const res = await fetch(withBasePath("/api/session/token"), { credentials: "same-origin" });
  if (!res.ok) {
    tokenCache = null;
    return null;
  }
  const body = (await res.json()) as { accessToken?: string; expiresIn?: number };
  if (!body.accessToken) return null;
  tokenCache = {
    accessToken: body.accessToken,
    expiresAt: now + (body.expiresIn ?? 3600) * 1000,
  };
  return tokenCache.accessToken;
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
 * HMAC-only in the sense that the HMAC is what identifies the *app*. It also
 * requires an end-user credential on top, which the proxy attaches server-side
 * from the session cookie — see cloud-data-server-program.ts. What the browser
 * sends is the cookie, and nothing else.
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
    const token = await getAccessToken().catch(() => null);
    if (!token) console.warn("[data-client] Remote target, no auth token — /api/* request will be unauthenticated");
    return {
      baseUrl: `${target.apiGatewayUrl.replace(/\/$/, "")}/apps/photos`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  }
  return { baseUrl: "", headers: {} };
}

/**
 * Data-plane fetch with one refresh-and-retry on a 401.
 *
 * The gateway's session authorizer cannot set cookies, so an `sk_token` that
 * expired mid-session yields a bare 401 with no way to recover in-band. The
 * recovery is a POST to the public /api/session/refresh, which authenticates
 * on `sk_session` in app code and issues a fresh token. Doing it here rather
 * than at each call site is the difference between one place that handles an
 * expired session and every place forgetting to.
 *
 * One retry, never a loop: if the refresh itself fails the session is really
 * over, and a second 401 is the answer rather than a reason to try again.
 */
export async function fetchWithSession(input: string, init?: RequestInit): Promise<Response> {
  const withCreds: RequestInit = { credentials: "same-origin", ...init };
  const first = await fetch(input, withCreds);
  if (first.status !== 401) return first;

  const refreshed = await fetch(withBasePath("/api/session/refresh"), {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => null);
  if (!refreshed?.ok) return first;

  // The minted token changed, so anything cached against the old one is stale.
  tokenCache = null;
  return fetch(input, withCreds);
}
