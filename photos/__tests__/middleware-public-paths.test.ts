/**
 * The middleware's allow-list and the manifest's must be the same list.
 *
 * They are the same list *today* because the middleware imports the manifest,
 * and this test exists so that stays true. The two describe one reality from
 * two sides: the manifest is what the install-time anonymous-route report
 * shows an operator, and the middleware is what the origin actually enforces.
 * If they drift, the report describes a deployment that does not exist — which
 * is the failure mode the report was added to prevent.
 *
 * The companion in manifest-routes.test.ts asserts *reachability* — that the
 * gateway hands a request to the app at all. This one asserts the opposite
 * half: which of those requests the app will answer without a session.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(
  readFileSync(resolve(PKG_DIR, "starkeep.manifest.json"), "utf-8"),
) as {
  infraRequirements: {
    compute: { handlers: { name: string; publicPaths?: string[] }[] };
  };
};

const middlewareSource = readFileSync(resolve(PKG_DIR, "middleware.ts"), "utf-8");

const staticHandler = manifest.infraRequirements.compute.handlers.find(
  (h) => h.name === "static",
)!;

describe("middleware public paths", () => {
  it("reads the list from the manifest rather than keeping a second copy", () => {
    expect(middlewareSource).toContain('from "./starkeep.manifest.json"');
    expect(middlewareSource).toContain("staticHandler.publicPaths");
  });

  it("declares exactly the paths an anonymous visitor needs and no more", () => {
    // Growing this list is a security decision, so it is spelled out here
    // rather than asserted by shape. The first three are the platform
    // defaults plus the build id the bundle wrapper serves; the last two are
    // what makes signing in possible at all.
    expect(staticHandler.publicPaths).toEqual([
      "/",
      "/_next/static/*",
      "/BUILD_ID",
      "/starkeep-runtime-config",
      "/sign-in",
      "/api/session/*",
    ]);
  });

  it("leaves the data proxy off the list", () => {
    // The path whose exposure was the incident, and the worst one here: list
    // responses embed CloudFront-signed rendition URLs inline, so an anonymous
    // 200 handed out the image bytes as well as the metadata.
    for (const entry of staticHandler.publicPaths ?? []) {
      const prefix = entry.endsWith("/*") ? entry.slice(0, -1) : null;
      expect(prefix && "/api/local-data/x".startsWith(prefix)).toBeFalsy();
      expect(entry).not.toBe("/api/local-data");
    }
  });

  it("leaves the local sync handoff off the list", () => {
    // It reads the session cookies and forwards them to the daemon, so an
    // anonymous caller reaching it would be asking the app to hand a
    // credential to a process on the user's machine.
    expect(staticHandler.publicPaths).not.toContain("/api/local-sync-handoff");
  });

  it("declares every path the bundle wrapper serves from disk", () => {
    // The wrapper answers these before the OpenNext handler runs, so before
    // the middleware — it is an enforcement bypass by construction. A path it
    // serves but the manifest does not declare is an anonymous route nobody
    // wrote down, and once publicPaths become real gateway routes it is also a
    // path the gateway refuses while the wrapper stands ready to serve it.
    const wrapper = readFileSync(resolve(PKG_DIR, "infra", "build-bundle.ts"), "utf-8");
    for (const rest of ["_next/static/", "BUILD_ID"]) {
      expect(wrapper, `wrapper should serve ${rest}`).toContain(rest);
      const declared = (staticHandler.publicPaths ?? []).some(
        (p) => p === `/${rest}` || (p.endsWith("/*") && `/${rest}`.startsWith(p.slice(0, -1))),
      );
      expect(declared, `/${rest} is served from disk but not declared public`).toBe(true);
    }
  });

  it("points the gate at a sign-in route the app actually serves", () => {
    expect(middlewareSource).toContain('signInPath: "/sign-in"');
    expect(staticHandler.publicPaths).toContain("/sign-in");
  });
});
