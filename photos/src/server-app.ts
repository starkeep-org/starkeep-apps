/**
 * Photos' server half, as a Hono app.
 *
 * `server-app.ts`, not `app.ts`: `app.tsx` at the package root is the browser
 * entry, and on a case-insensitive filesystem a bare `./app` specifier resolves
 * `.ts` before `.tsx`. The browser bundle would then pull in the signing proxy,
 * sharp, `onnxruntime-node` and every Node builtin behind them.
 *
 * Twenty-two handlers and one gate. Everything else a browser asks for is the
 * client half: `index.html` and the content-hashed bundle beside it, served
 * from disk by `createWebAppHandler` in the cloud and by `src/serve.ts`
 * locally.
 *
 * **Every route here is written app-relative.** In the cloud the platform
 * mounts the app at `/apps/photos` and the Lambda sees that prefix, but
 * `honoUpstream` rewrites the request's URL to the app-relative path before
 * Hono routes it, so nothing below names the mount. Client code that has to
 * emit a URL a browser will resolve uses `withBasePath` (`src/lib/base-path.ts`)
 * against the same value.
 *
 * The imports below are also the dispatch table
 * `__tests__/worker-bundle-isolation.test.ts` walks. Under the previous
 * framework the route set was a directory tree and the guard walked `app/`;
 * now every route this app serves is a module reached from here, and that test
 * asserts both halves of it — that no route reaches an isolated engine, and
 * that no file under `src/routes/` is missing from this graph.
 */

import { Hono } from "hono";
import { appBasePath, honoOriginGate } from "@starkeep/app-client/hono";
import manifest from "../starkeep.manifest.json";
import { proxy } from "./routes/local-data";
import { routes as sessionRoutes } from "./routes/session";
import { GET as runtimeConfig } from "./routes/runtime-config";
import { POST as share } from "./routes/share";
import { POST as resize } from "./routes/resize";
import { POST as localSyncHandoff } from "./routes/local-sync-handoff";
import * as photoById from "./routes/photos/by-id";
import * as captions from "./routes/photos/captions";
import * as cover from "./routes/photos/cover";
import * as library from "./routes/photos/library";
import * as renditions from "./routes/photos/renditions";
import * as styleGraphic from "./routes/photos/style-graphic";
import * as deriveStatus from "./routes/derive/status";
import * as deriveSweep from "./routes/derive/sweep";
import * as visionConfig from "./routes/vision/config";
import * as visionFaceCrop from "./routes/vision/face-crop";
import * as visionFaces from "./routes/vision/faces";
import * as visionModels from "./routes/vision/models";
import * as visionPeople from "./routes/vision/people";
import * as visionScan from "./routes/vision/scan";
import * as visionStatus from "./routes/vision/status";

// Narrowed by hand, because the manifest's two handlers have different shapes
// and a JSON import types the array as their union: only `static` carries
// `publicPaths`, so TypeScript sees it as optional on every element.
const staticHandler = manifest.infraRequirements.compute.handlers.find(
  (h): h is typeof h & { publicPaths: string[] } =>
    h.name === "static" && Array.isArray((h as { publicPaths?: unknown }).publicPaths),
);
if (!staticHandler) throw new Error("photos manifest has no `static` compute handler with publicPaths");

/**
 * The paths the server half owns; everything else belongs to the client.
 *
 * One statement, read twice: `src/client-serving.ts` splits the local surface
 * on it, and the routes below are registered under it. Anything under `/api`
 * stays the server's even when no route matches, so an unrouted API path
 * answers JSON rather than falling through to the shell and reporting a parse
 * error at whichever caller asked.
 */
export function isServerPath(pathname: string): boolean {
  return (
    pathname === "/starkeep-runtime-config" ||
    pathname === "/api" ||
    pathname.startsWith("/api/")
  );
}

export const app = new Hono();

/**
 * The origin gate, deny-by-default over the manifest's own `publicPaths`.
 *
 * Read from the manifest rather than plumbed through an environment variable,
 * and that is not a convenience: the install-time anonymous-route report
 * describes this same list, so taking both from one file makes the drift
 * impossible. A gate whose allow-list came from an env var that failed to
 * arrive would fail in whichever direction its author did not think about.
 *
 * This is not the only gate and in the cloud it is not the one that matters —
 * the API Gateway's session authorizer refuses an anonymous request before it
 * reaches this bundle. It is inert on the local surface by construction
 * (`createOriginGate` returns immediately unless `STARKEEP_APP_CLIENT_MODE` is
 * `cloud`), because on the loopback surface the browser, the data and the
 * person are one machine. It stays because it is the gate an app served outside
 * the gateway would still have, and because it still applies if a `publicPaths`
 * entry is ever declared wider than intended.
 */
app.use(
  "*",
  honoOriginGate({
    publicPaths: staticHandler.publicPaths,
    signInPath: "/sign-in",
    // `publicPaths` is matched app-relative, because `honoUpstream` strips the
    // mount before the gate sees the pathname. The redirect is not: a browser
    // resolves `Location` against the distribution, where `/sign-in` belongs to
    // nobody and Photos' is at `/apps/photos/sign-in`.
    basePath: appBasePath(),
  }),
);

app.get("/starkeep-runtime-config", () => runtimeConfig());

// Both spellings, because the empty action is a real one: `GET /api/session`
// is the signed-in probe `AuthGate` runs, and a router's `*` does not match the
// prefix itself.
const session = (c: { req: { raw: Request; path: string; method: string } }) => {
  const rest = c.req.path.slice("/api/session".length);
  const action = rest.split("/").filter(Boolean);
  const ctx = { params: Promise.resolve({ action }) };
  if (c.req.method === "POST") return sessionRoutes.POST(c.req.raw, ctx);
  if (c.req.method === "GET") return sessionRoutes.GET(c.req.raw, ctx);
  return Response.json({ error: "Method not allowed" }, { status: 405 });
};
app.all("/api/session", session);
app.all("/api/session/*", session);

// The signing proxy: the browser's only route to the data plane, and the only
// place Photos' HMAC secret is used. Every verb the client issues is mounted,
// which is what the manifest's `ANY /{proxy+}` has to keep admitting.
app.all("/api/local-data/*", (c) => {
  const path = c.req.path.slice("/api/local-data/".length).split("/").filter(Boolean);
  return proxy(c.req.raw, { params: Promise.resolve({ path }) });
});

// Photos' own data routes. `library` and `renditions` resolve the size ladder
// and so take the request; the rest are thin mediations of one platform
// endpoint each.
app.get("/api/photos/library", (c) => library.GET(c.req.raw));
app.post("/api/photos/renditions", (c) => renditions.POST(c.req.raw));

app.get("/api/photos/cover", () => cover.GET());
app.put("/api/photos/cover", (c) => cover.PUT(c.req.raw));
app.delete("/api/photos/cover", () => cover.DELETE());

app.get("/api/photos/style-graphic", () => styleGraphic.GET());
app.put("/api/photos/style-graphic", (c) => styleGraphic.PUT(c.req.raw));
app.delete("/api/photos/style-graphic", () => styleGraphic.DELETE());

// Registered ahead of `/api/photos/:id` so a literal segment is never eaten by
// the parameter. Hono matches in registration order, and `captions` is the one
// two-segment path under this prefix.
app.get("/api/photos/captions/:id", (c) => captions.GET(c.req.raw, c.req.param("id")));
app.put("/api/photos/captions/:id", (c) => captions.PUT(c.req.raw, c.req.param("id")));
app.delete("/api/photos/captions/:id", (c) => captions.DELETE(c.req.raw, c.req.param("id")));

app.get("/api/photos/:id", (c) => photoById.GET(c.req.raw, c.req.param("id")));
app.patch("/api/photos/:id", (c) => photoById.PATCH(c.req.raw, c.req.param("id")));
app.delete("/api/photos/:id", (c) => photoById.DELETE(c.req.raw, c.req.param("id")));

app.post("/api/resize", (c) => resize(c.req.raw));
app.post("/api/share", () => share());
app.post("/api/local-sync-handoff", (c) => localSyncHandoff(c.req.raw));

app.get("/api/derive/status", () => deriveStatus.GET());
app.post("/api/derive/sweep", (c) => deriveSweep.POST(c.req.raw));

app.get("/api/vision/config", () => visionConfig.GET());
app.put("/api/vision/config", (c) => visionConfig.PUT(c.req.raw));
app.get("/api/vision/status", () => visionStatus.GET());
app.post("/api/vision/scan", (c) => visionScan.POST(c.req.raw));
app.post("/api/vision/models", (c) => visionModels.POST(c.req.raw));
app.get("/api/vision/people", () => visionPeople.GET());
app.put("/api/vision/people", (c) => visionPeople.PUT(c.req.raw));
app.get("/api/vision/faces/:id", (c) => visionFaces.GET(c.req.raw, c.req.param("id")));
app.get("/api/vision/face-crop/:id", (c) => visionFaceCrop.GET(c.req.raw, c.req.param("id")));

app.notFound((c) =>
  Response.json({ error: `Photos has no route for ${c.req.path}` }, { status: 404 }),
);
