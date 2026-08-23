import { createAuthGateMiddleware } from "@starkeep/app-client/edge";
import manifest from "./starkeep.manifest.json";

/**
 * The origin gate. Deny-by-default: a path the manifest has not declared
 * public gets a redirect to sign-in (for a navigation) or a 401 (for anything
 * else), before any route handler runs.
 *
 * `publicPaths` is read from the manifest rather than plumbed through an env
 * var, and that is not a convenience. Next inlines statically-referenced
 * `process.env` in the edge runtime at build time, so an env-carried list
 * would be `undefined` in exactly the place it matters — and a gate whose
 * allow-list is `undefined` fails in whichever direction its author did not
 * think about. Reading the manifest also makes the drift impossible: the
 * install-time anonymous-route report describes this same list.
 *
 * `middleware.ts` rather than Next 16's newer `proxy.ts`, because "the proxy"
 * already names the data proxy at app/api/local-data.
 *
 * This is not the only gate, and after the platform session authorizer lands
 * it is not the one that matters: the API Gateway refuses an anonymous request
 * before it reaches this bundle at all. This stays because it is the only gate
 * on the local surface, where there is no gateway, and because it still
 * applies if a publicPaths entry is ever declared wider than intended.
 */
const staticHandler = manifest.infraRequirements.compute.handlers.find(
  (h) => h.name === "static",
);
if (!staticHandler?.publicPaths) {
  throw new Error("photos manifest has no `static` compute handler with publicPaths");
}

export default createAuthGateMiddleware({
  publicPaths: staticHandler.publicPaths,
  signInPath: "/sign-in",
  basePath: process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH ?? "",
});

// `_next/static` is excluded here because the bundle wrapper serves those from
// disk before the OpenNext handler runs, so the matcher would be describing a
// reach the middleware does not have. It is declared public in the manifest
// either way — static chunks are application code, not user data.
export const config = { matcher: "/((?!_next/static).*)" };
