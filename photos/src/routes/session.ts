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
// The action is the path below `/api/session`, and the empty action is a real
// one: `GET /api/session` is the signed-in probe `AuthGate` runs. The previous
// framework spelled that as an optional catch-all segment, `[[...action]]`;
// `src/server-app.ts` spells it as two routes, because a router's `*` does not
// match the prefix itself.
//
// Env is read at request time — the pool ids are injected into the Lambda, not
// baked into the build. The previous framework needed
// `export const dynamic = "force-dynamic"` beside this to get that; a plain
// Node server has it by construction.
export const routes = createSessionRoutes({ appId: "photos" });
