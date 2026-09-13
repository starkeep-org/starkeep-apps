/**
 * The `static` handler: the single Lambda a browser reaches.
 *
 * Declared `auth: "session"` in the manifest, so the gateway's session
 * authorizer gates every path except the ones the manifest lists as public.
 *
 * What this Lambda answers splits three ways, and the split is the whole shape
 * of the migration off a server-rendering framework:
 *
 *   - A content-hashed asset is a file staged in the zip, read from disk.
 *   - A client route — `/` and `/sign-in` — is `index.html`, also read from
 *     disk. The shell is a file now rather than a response the framework
 *     rendered per request, which is what `infra/prerender-cache.ts` existed to
 *     approximate.
 *   - Everything else is the Hono app: the session routes, the signing proxy,
 *     Photos' own data routes, and the vision and derive routes that answer 501
 *     here.
 *
 * All three are the platform's adapter. `createWebAppHandler` awaits the app's
 * module graph at module scope, so the graph loads during Lambda's INIT phase —
 * elevated CPU, unbilled, its own budget — rather than inside the billed first
 * request.
 *
 * `POST /api/resize` never arrives here. The manifest routes it to the separate
 * `api` handler (`infra/src/resize-handler.ts`), which has 512 MB and thirty
 * seconds where this one has 256 MB and ten. The route registered on the Hono
 * app is the local surface's.
 */

import { createWebAppHandler } from "@starkeep/app-client/web";
import { honoUpstream } from "@starkeep/app-client/hono";
import manifest from "../starkeep.manifest.json";
import { CLIENT_ROUTES } from "./client-routes";

// Narrowed by hand, because the manifest's two handlers have different shapes
// and a JSON import types the array as their union: only `static` carries
// `staticAssetPaths`, so TypeScript sees it as optional on every element.
const shell = manifest.infraRequirements.compute.handlers.find(
  (h): h is typeof h & { staticAssetPaths: string[] } =>
    h.name === "static" && Array.isArray((h as { staticAssetPaths?: unknown }).staticAssetPaths),
);
if (!shell) throw new Error("photos manifest has no `static` compute handler with staticAssetPaths");

const clientRoutes: readonly string[] = CLIENT_ROUTES;

/**
 * The manifest's `staticAssetPaths` is the whole list of paths this bundle
 * answers from disk ahead of the app's own gate, which is what the schema
 * checks against `publicPaths`. The adapter wants it split: the client routes
 * are answered with the shell, everything else with a file of its own. Taking
 * the difference here rather than writing two lists in the manifest keeps the
 * schema's subset rule applying to both halves.
 */
const staticPaths = shell.staticAssetPaths.filter((p) => !clientRoutes.includes(p));

export const handler = await createWebAppHandler({
  // The platform mounts the app here, and the Lambda sees the full path.
  basePath: `/apps/${manifest.id}`,
  // Staged by infra/build-bundle.ts from `vite build`'s output.
  assetsDir: new URL("./assets/", import.meta.url),
  staticPaths,
  shellPaths: [...clientRoutes],
  // `/_immutable/*` is the platform's reserved prefix for content-addressed
  // output, and `vite.config.ts` sets `assetsDir` to match. The adapter has no
  // default: a path cached forever by accident is unrecoverable at the edge
  // until its TTL expires, so the app names the prefix it hashes into.
  immutablePaths: ["/_immutable/*"],
  // The staged assets are the whole truth for the paths above: `vite build`
  // emits them and nothing in the Hono app claims a sibling path under the same
  // prefix. A miss is a broken build, and a 404 says so where a fall-through
  // would answer a JSON "no route" from the app instead.
  staticMiss: "notFound",
  // `.then` on an already-started import, not a thunk, so the mapping settles
  // during INIT. `honoUpstream` rewrites the URL to the app-relative path,
  // which is why no route in `src/server-app.ts` names `/apps/photos`.
  requestUpstream: import("./server-app.js").then((m) => ({ handler: honoUpstream(m.app) })),
  // Answered rather than thrown: a thrown Lambda error becomes a bare 502 with
  // nothing in the response to say what failed.
  onError: (err) => ({
    statusCode: 500,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: `photos static handler: ${String(err)}` }),
  }),
});
