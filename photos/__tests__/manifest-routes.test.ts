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
 * live deployment can answer it.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
