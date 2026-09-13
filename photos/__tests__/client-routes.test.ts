/**
 * The client-route list, held in agreement with everything that reads it.
 *
 * Four statements of one fact, and each is load-bearing on its own:
 *
 *   - `src/client-routes.ts` is the list.
 *   - `src/main.tsx` decides which component to mount from it.
 *   - The manifest's `publicPaths` makes each one reachable without a session.
 *   - The manifest's `staticAssetPaths` makes each one answered from disk by
 *     `createWebAppHandler` ahead of the app's own gate.
 *
 * The last two are why this is a security test as much as a routing one. A
 * path in `staticAssetPaths` is served before the origin gate runs, so every
 * entry is an enforcement bypass by construction — which is fine when the
 * answer is `index.html`, a file that carries no data, and is not fine for
 * anything else.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLIENT_ROUTES, SIGN_IN_ROUTE } from "@/client-routes";
import { appRelativePath } from "@/lib/base-path";
import { isClientRoute } from "@/client-serving";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(
  readFileSync(resolve(PKG_DIR, "starkeep.manifest.json"), "utf8"),
) as {
  infraRequirements: {
    compute: { handlers: { name: string; publicPaths?: string[]; staticAssetPaths?: string[] }[] };
  };
};

const staticHandler = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static")!;

describe("the manifest and the route list", () => {
  it("declares every client route public", () => {
    for (const route of CLIENT_ROUTES) {
      expect(staticHandler.publicPaths, `${route} is not declared public`).toContain(route);
    }
  });

  it("serves every client route from disk", () => {
    for (const route of CLIENT_ROUTES) {
      expect(staticHandler.staticAssetPaths, `${route} is not served from disk`).toContain(route);
    }
  });

  it("keeps staticAssetPaths inside publicPaths", () => {
    // The platform schema's own rule, restated here because a violation is a
    // path served ahead of the gate that the install-time report never listed.
    for (const path of staticHandler.staticAssetPaths ?? []) {
      expect(staticHandler.publicPaths, `${path} is served but not declared`).toContain(path);
    }
  });

  it("serves nothing from disk but the shell and the hashed bundle", () => {
    // Everything answered ahead of the gate, enumerated. `/_immutable/*` is
    // content-hashed output; the rest is `index.html` under two names.
    expect(staticHandler.staticAssetPaths).toEqual([...CLIENT_ROUTES, "/_immutable/*"]);
  });
});

describe("the two surfaces agree on which paths are the client's", () => {
  it.each([...CLIENT_ROUTES])("%s is a client route locally", (route) => {
    expect(isClientRoute(route)).toBe(true);
  });

  it("refuses an undeclared path rather than falling back to the shell", () => {
    // A development server's blanket SPA fallback would answer this, and the
    // cloud would 403 it. Matching the cloud's answer locally is what makes an
    // undeclared route fail here rather than after a deploy.
    expect(isClientRoute("/albums")).toBe(false);
    expect(isClientRoute("/sign-in/extra")).toBe(false);
  });
});

describe("the browser's own routing decision", () => {
  it("strips the mount before matching, so the cloud path resolves", () => {
    const saved = process.env.STARKEEP_APP_BASE_PATH;
    try {
      // `appRelativePath` reads `BASE_PATH`, which is a module-level constant,
      // so the local spelling is what this process can check directly.
      expect(appRelativePath("/sign-in")).toBe(SIGN_IN_ROUTE);
      expect(appRelativePath("/")).toBe("/");
      expect(appRelativePath("")).toBe("/");
    } finally {
      if (saved === undefined) delete process.env.STARKEEP_APP_BASE_PATH;
      else process.env.STARKEEP_APP_BASE_PATH = saved;
    }
  });

  it("strips a cloud mount from every client route", async () => {
    // Re-imported with the mount set, because `BASE_PATH` is read once at
    // module load — which is what the built bundle does with the literal Vite
    // substituted in.
    const { appRelativePath: cloudRelative } = await (async () => {
      process.env.STARKEEP_APP_BASE_PATH = "/apps/photos";
      const mod = await import(`@/lib/base-path?cloud=${Date.now()}`);
      delete process.env.STARKEEP_APP_BASE_PATH;
      return mod as { appRelativePath: (p: string) => string };
    })();
    for (const route of CLIENT_ROUTES) {
      expect(cloudRelative(`/apps/photos${route === "/" ? "" : route}`)).toBe(route);
    }
  });

  it("names a sign-in route that is in the list", () => {
    expect(CLIENT_ROUTES).toContain(SIGN_IN_ROUTE);
  });
});
