/**
 * The origin gate, asserted by what it does rather than by what its source
 * says.
 *
 * The test this replaces read `middleware.ts` back as text and checked that the
 * file contained the substring `staticHandler.publicPaths`. It tested no
 * behavior, and it died with the file when the framework left. What it was
 * reaching for is real and is kept: the gate's allow-list and the manifest's
 * must be one list, because the install-time anonymous-route report shows an
 * operator the manifest while the origin enforces the gate. If they drift, the
 * report describes a deployment that does not exist.
 *
 * Everything below drives the real Hono app from `src/server-app.ts`, which
 * mounts the real gate over the real manifest.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "@/server-app";
import { CLIENT_ROUTES } from "@/client-routes";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(
  readFileSync(resolve(PKG_DIR, "starkeep.manifest.json"), "utf8"),
) as {
  infraRequirements: {
    compute: { handlers: { name: string; auth?: string; publicPaths?: string[] }[] };
  };
};

const staticHandler = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static")!;
const publicPaths = staticHandler.publicPaths!;

/** A document navigation, the way a browser spells one. */
function navigate(path: string): Request {
  return new Request(`http://photos.test${path}`, { headers: { "sec-fetch-dest": "document" } });
}

/** Anything that is not a navigation: an XHR, a fetch, a paired device. */
function call(path: string, method = "GET"): Request {
  return new Request(`http://photos.test${path}`, {
    method,
    headers: { "sec-fetch-dest": "empty" },
  });
}

beforeEach(() => {
  vi.stubEnv("STARKEEP_APP_CLIENT_MODE", "cloud");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the origin gate in cloud mode", () => {
  it("lets every path the manifest declares public through", async () => {
    for (const entry of publicPaths) {
      // A glob's probe is a path under it; a literal entry is itself.
      const path = entry.endsWith("/*") ? `${entry.slice(0, -2)}/probe` : entry;
      const res = await app.fetch(navigate(path));
      expect(res.status, `${entry} (declared public) answered ${res.status}`).not.toBe(302);
      expect(res.status, `${entry} (declared public) answered ${res.status}`).not.toBe(401);
    }
  });

  it("sends an undeclared document navigation to sign-in", async () => {
    const res = await app.fetch(navigate("/api/local-data/data/records"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://photos.test/sign-in");
  });

  it("puts the app's own mount on that redirect when it has one", async () => {
    // Not `/sign-in` at the distribution root: a browser resolves `Location`
    // against the origin, where that path belongs to nobody and Photos' is at
    // `/apps/photos/sign-in`. That is the bug Phase 2 found in the platform.
    //
    // Re-imported rather than stubbed in place, because the gate reads the
    // mount once when the module loads — which is what the Lambda does, with
    // the installer's environment already in place.
    vi.resetModules();
    vi.stubEnv("STARKEEP_APP_BASE_PATH", "/apps/photos");
    const { app: mounted } = await import("@/server-app");
    try {
      const res = await mounted.fetch(navigate("/api/local-data/data/records"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://photos.test/apps/photos/sign-in");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("answers 401 to an undeclared path that is not a navigation", async () => {
    const res = await app.fetch(call("/api/local-data/data/records", "POST"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authenticated" });
  });

  it("keeps the data proxy behind the gate, which is the whole point", async () => {
    // The one path whose exposure was the 2026-08 incident, and the worst one
    // here: Photos' list responses embed CloudFront-signed rendition URLs
    // inline, so an anonymous 200 handed out the image bytes as well as the
    // metadata. Asserted directly, because "absent from a list of five" is easy
    // to reintroduce.
    for (const entry of publicPaths) {
      const prefix = entry.endsWith("/*") ? entry.slice(0, -1) : null;
      expect(prefix && "/api/local-data/x".startsWith(prefix)).toBeFalsy();
      expect(entry).not.toBe("/api/local-data");
    }
    expect((await app.fetch(call("/api/local-data/data/records"))).status).toBe(401);
  });

  it("keeps the local sync handoff behind the gate", async () => {
    // It reads the session cookies and forwards them to a daemon on the user's
    // machine, so an anonymous caller reaching it would be asking the app to
    // hand out a credential.
    expect(publicPaths).not.toContain("/api/local-sync-handoff");
    expect((await app.fetch(call("/api/local-sync-handoff", "POST"))).status).toBe(401);
  });

  it("lets a request carrying a session cookie past, for the real gate to judge", async () => {
    // Presence, not validity: verifying here would put a JWKS fetch in front of
    // every request, and what decides is the proxy's own `sessionAuth()` and
    // the gateway authorizer ahead of it.
    //
    // An undeclared path with no route behind it is what makes "the gate
    // passed" observable: refused it is the gate's 401, passed it is the app's
    // own 404. On a path that does have a handler the two answers are both 401
    // and the test would be asserting nothing.
    const refused = await app.fetch(call("/nothing-declared"));
    expect(refused.status).toBe(401);

    const passed = await app.fetch(
      new Request("http://photos.test/nothing-declared", {
        headers: { cookie: "sk_session=whatever", "sec-fetch-dest": "empty" },
      }),
    );
    expect(passed.status).toBe(404);
    expect(await passed.json()).toEqual({
      error: "Photos has no route for /nothing-declared",
    });
  });
});

describe("the origin gate on the local surface", () => {
  it("refuses nothing, because the browser, the data and the person are one machine", async () => {
    vi.stubEnv("STARKEEP_APP_CLIENT_MODE", "");
    for (const path of ["/api/local-data/data/records", "/nothing-declared"]) {
      const res = await app.fetch(navigate(path));
      expect(res.status, `${path} was gated locally`).not.toBe(302);
      expect(res.status, `${path} was gated locally`).not.toBe(401);
    }
  });
});

describe("what the manifest declares public", () => {
  it("is exactly the client routes, the served files, and what sign-in needs", () => {
    // Growing this list is a security decision, so it is spelled out here
    // rather than asserted by shape. `/_next/static/*` and `/BUILD_ID` left
    // with the framework; `/_immutable/*` is what the build emits now.
    expect(publicPaths).toEqual([
      ...CLIENT_ROUTES,
      "/_immutable/*",
      "/starkeep-runtime-config",
      "/api/session/*",
    ]);
  });

  it("declares no wildcard that would un-gate the whole app", () => {
    // `publicPaths: ["/*"]` derives the gateway route `ANY /{proxy+}`, which
    // *replaces* the handler's gated catch-all and takes the authorizer off the
    // data proxy. `@starkeep/admin-manifest` refuses that entry; this asserts
    // Photos never reaches for it, which is the temptation an SPA's shell
    // fallback creates.
    expect(publicPaths).not.toContain("/*");
  });

  it("gates the handler itself, so the declaration is the reach", () => {
    expect(staticHandler.auth).toBe("session");
  });

  it("points the gate at a sign-in route the app actually serves", () => {
    expect(publicPaths).toContain("/sign-in");
    expect(CLIENT_ROUTES).toContain("/sign-in");
  });
});
