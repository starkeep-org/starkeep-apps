/**
 * Photos' client routes, in one list, read by three places that must agree.
 *
 *   - `src/main.tsx` picks which of the two to render.
 *   - `src/static-handler.ts` hands them to `createWebAppHandler` as
 *     `shellPaths`, so the Lambda answers each one with `index.html` from disk
 *     rather than passing it to the app.
 *   - `src/client-serving.ts` does the same for the local surface.
 *
 * The manifest declares the same paths inside `publicPaths` and
 * `staticAssetPaths`, because the shell is served ahead of the app's own gate
 * and every path that reaches it that way is an enforcement bypass by
 * construction. `__tests__/client-routes.test.ts` holds the lists in agreement.
 *
 * Enumerated rather than declared as one wildcard. A `publicPaths` entry of
 * `/*` derives the gateway route `ANY /{proxy+}`, which *replaces* the gated
 * catch-all and takes the authorizer off the data proxy — the exact inversion
 * the 2026-08-23 postmortem was written about.
 *
 * Two entries, and no router. Photos is one screen plus a sign-in page, so the
 * whole routing decision is which of two components to mount; pulling in a
 * router to express that would add a dependency to say `if`.
 */
export const CLIENT_ROUTES = ["/", "/sign-in"] as const;

export const SIGN_IN_ROUTE = "/sign-in";
