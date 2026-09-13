/**
 * Manifest ↔ client route-coverage contract.
 *
 * The catastrophic reinstall failure had two halves. This guards the second:
 * the app's `compute.handlers[].routes` must declare an API-Gateway route for
 * every same-origin (method, path) the browser actually issues. The old
 * manifest routed only `GET /{proxy+}` to the Next.js server, so every POST/PUT/
 * DELETE the browser made — the /api/local-data proxy uploads and metadata
 * writes, /api/share — silently 404'd at the gateway after a cloud reinstall,
 * even though every unit test passed.
 *
 * The matcher below mirrors the installer's route semantics (admin-installer/
 * src/pulumi-program.ts): a declared route covers a request when the method is
 * an exact match or `ANY`, and the path matches literally or via a trailing
 * `{proxy+}` wildcard. A route may be a bare `"<METHOD> <path>"` string or the
 * object form `{ route, auth }` that carries a per-route auth override.
 *
 * This file asserts *reachability only* — that the gateway will hand the
 * request to the app at all. It deliberately says nothing about who is allowed
 * to make it, and for three months that omission let it pin an exposed shape in
 * place without anyone noticing (postmortem 2026-08-23, timeline 2026-07-04).
 * The auth counterpart lives one tier up, in starkeep-core/e2e-aws's
 * "refuses an unauthenticated caller on every app data path", because only a
 * live deployment can answer it, and in `__tests__/origin-gate.test.ts` for
 * what the app itself refuses.
 *
 * **A third table arrived with the migration.** The browser's fetch sites and
 * the manifest's gateway routes used to be the only two; the app's own Hono
 * router is now a third, and the three must agree. A route the router mounts
 * that the gateway does not admit is a 404 nobody sees until a cloud install;
 * a route the gateway admits that the router does not mount is a path reaching
 * the Lambda to be told it does not exist. The second half of this file walks
 * the real dispatch table through `matchRoute` from `@starkeep/admin-manifest`,
 * which is the installer's own matcher rather than a copy of it.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchRoute, resolveHandlerRoutes, type AppComputeHandler } from "@starkeep/admin-manifest";
import { app } from "@/server-app";
import { CLIENT_ROUTES } from "@/client-routes";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Route = string | { route: string; auth?: "public" | "jwt" };
interface Handler {
  name: string;
  routes?: Route[];
}
const manifest = JSON.parse(
  readFileSync(resolve(PKG_DIR, "starkeep.manifest.json"), "utf-8"),
) as { infraRequirements?: { compute?: { handlers?: Handler[] } } };

const handlers = manifest.infraRequirements?.compute?.handlers ?? [];
const declaredRoutes: string[] = handlers.flatMap((h) =>
  (h.routes ?? []).map((r) => (typeof r === "string" ? r : r.route)),
);

/** Does a single declared route string cover (method, path)? */
function routeCovers(route: string, method: string, path: string): boolean {
  const m = route.match(/^([A-Z]+) (\/.*)$/);
  if (!m) return false;
  const [, routeMethod, routePath] = m;
  if (routeMethod !== "ANY" && routeMethod !== method) return false;
  if (routePath === path) return true;
  if (routePath.endsWith("/{proxy+}")) {
    const base = routePath.slice(0, -"/{proxy+}".length); // "" for "/{proxy+}"
    return path.startsWith(base + "/");
  }
  return false;
}

const covered = (method: string, path: string): boolean =>
  declaredRoutes.some((r) => routeCovers(r, method, path));

// The same-origin surface the browser calls. Data-plane paths (/api/local-data/*)
// are forwarded verbatim by the proxy to the data server, so the manifest must
// admit every verb the client uses against them. Kept in sync with
// src/lib/data-server-client.ts and app/api/*.
const REQUIRED: ReadonlyArray<{ method: string; path: string; why: string }> = [
  { method: "GET", path: "/api/local-data/data/records", why: "listPhotos" },
  { method: "POST", path: "/api/local-data/data/records", why: "addPhotoFromPath register-by-hash" },
  { method: "POST", path: "/api/local-data/files/presign", why: "upload presign" },
  { method: "POST", path: "/api/local-data/data/records/rec1/metadata", why: "image metadata write" },
  { method: "GET", path: "/api/local-data/data/records/rec1/file-url", why: "getPhotoFileUrl" },
  { method: "POST", path: "/api/resize", why: "server-side thumbnail generation" },
  { method: "POST", path: "/api/share", why: "share API route" },
];

describe("manifest route coverage", () => {
  it.each(REQUIRED)("routes $method $path ($why)", ({ method, path }) => {
    expect(
      covered(method, path),
      `No manifest route covers ${method} ${path}. Declared: ${JSON.stringify(declaredRoutes)}`,
    ).toBe(true);
  });

  it("routes non-GET methods through the /api/local-data proxy (guards the GET-only regression)", () => {
    // The signing proxy (createNextProxyHandler) is mounted for GET/POST/PUT/
    // PATCH/DELETE; a catch-all that only admits GET makes every write fail in
    // cloud. Assert each write verb reaches the proxy.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        covered(method, "/api/local-data/data/records/rec1"),
        `${method} /api/local-data/* is not routed — the proxy catch-all must be ANY, not GET-only`,
      ).toBe(true);
    }
  });
});

/**
 * The router's dispatch table, as (method, path) pairs the gateway can be asked
 * about. Hono's `:id` parameters become a concrete sample value and its `*`
 * becomes a path under the prefix, because a gateway route matches paths, not
 * patterns.
 */
function dispatchTable(): Array<{ method: string; path: string }> {
  return app.routes
    .filter((r) => r.path !== "/*") // the origin gate, mounted with `app.use`
    .map((r) => ({
      method: r.method === "ALL" ? "GET" : r.method.toUpperCase(),
      path: r.path.replace(/:[^/]+/g, "sample").replace(/\/\*$/, "/sample"),
    }))
    .filter((r, i, a) => a.findIndex((x) => x.method === r.method && x.path === r.path) === i);
}

const staticHandler = handlers.find((h) => h.name === "static") as unknown as AppComputeHandler;

describe("the router and the manifest agree", () => {
  it("walks a dispatch table that is not empty", () => {
    // The assertions below are `every`-shaped, so an empty table would pass
    // them all. The router mounts twenty-odd routes; five is a floor that
    // cannot be reached by accident.
    expect(dispatchTable().length).toBeGreaterThan(5);
  });

  it("declares a gateway route for every path the app mounts", () => {
    const resolved = resolveHandlerRoutes(staticHandler);
    const unreachable = dispatchTable().filter(
      ({ method, path }) => matchRoute(resolved, method, path) === null,
    );
    expect(
      unreachable,
      `The gateway would 404 these before the app saw them: ${JSON.stringify(unreachable)}`,
    ).toEqual([]);
  });

  it("mounts a handler for every path the manifest declares public", () => {
    // The other direction, and the one that matters for the shell: a declared
    // public path with nothing behind it is a 404 an anonymous caller reaches,
    // which is how a sign-in page that cannot load its own config looks.
    const publicPaths = (staticHandler.publicPaths ?? []).filter(
      (p) => !p.startsWith("/_immutable"),
    );
    for (const path of publicPaths) {
      const probe = path.endsWith("/*") ? `${path.slice(0, -2)}/probe` : path;
      const mounted =
        // A client route is answered from disk by the adapter, ahead of the app.
        CLIENT_ROUTES.includes(probe as (typeof CLIENT_ROUTES)[number]) ||
        app.routes.some(
          (r) => r.path === probe || (r.path.endsWith("/*") && probe.startsWith(r.path.slice(0, -1))),
        );
      expect(mounted, `${path} is declared public but nothing answers it`).toBe(true);
    }
  });
});
