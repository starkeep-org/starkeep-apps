import { createSessionRoutes } from "@starkeep/app-client/auth";

/**
 * Sign-in, sign-out, refresh, and a signed-in probe. The whole flow runs
 * server-side: the browser posts a password here and gets back cookies, never
 * a Cognito credential it could store or an XSS could read.
 *
 * `GET /api/session/token` is the one exception, and it is deliberate. Photos
 * posts to /api/resize directly on the gateway, where the route is JWT-gated
 * and a cookie cannot serve — so the page needs a bearer token. What it gets
 * is good for an hour; the refresh token stays here.
 */
const routes = createSessionRoutes({ appId: "photos" });

// Env is read at request time — the pool ids are injected into the Lambda, not
// baked into the build.
export const dynamic = "force-dynamic";

export const { GET, POST } = routes;
