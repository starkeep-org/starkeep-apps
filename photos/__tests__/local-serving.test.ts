/**
 * What the local surface answers, and in what order.
 *
 * The local surface used to be `next dev`, so none of this was Photos': the
 * framework owned the routing, the MIME types, the cache headers and the path
 * containment. It is `src/client-serving.ts` now, and the decision it makes has
 * to match the one the platform's web adapter makes in the cloud — otherwise an
 * app that works on a laptop answers differently after a deploy, which is the
 * class of failure this whole migration was meant to shrink rather than grow.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIST_DIR,
  SHELL,
  isClientRoute,
  resolveClientRequest,
} from "@/client-serving";
import { isServerPath } from "@/server-app";

describe("which half of the server owns a path", () => {
  it.each([
    "/starkeep-runtime-config",
    "/api",
    "/api/session",
    "/api/local-data/data/records",
    "/api/photos/library",
    "/api/vision/status",
  ])("%s is the server's", (path) => {
    expect(isServerPath(path)).toBe(true);
  });

  it.each(["/", "/sign-in", "/_immutable/index-abc.js", "/favicon.ico"])(
    "%s is the client's",
    (path) => {
      expect(isServerPath(path)).toBe(false);
    },
  );

  it("keeps an unrouted /api path on the server side", () => {
    // So it answers JSON rather than the shell. A shell served to a `fetch`
    // reports a parse error at the caller instead of a missing route.
    expect(isServerPath("/api/not-a-route")).toBe(true);
  });

  it("does not claim a path that merely starts with the letters api", () => {
    expect(isServerPath("/apiary")).toBe(false);
  });
});

describe("what the built client answers", () => {
  it("answers the app root with the shell rather than reading the directory", () => {
    // `/` joins to the build directory itself, and reading a directory throws
    // EISDIR — which was a 500 on the app's own front page.
    const answer = resolveClientRequest("/");
    expect(answer.kind).toBe("shell");
    if (answer.kind === "shell") expect(answer.file).toBe(SHELL);
  });

  it("answers the sign-in route with the same shell", () => {
    const answer = resolveClientRequest("/sign-in");
    expect(answer.kind).toBe("shell");
  });

  it("refuses an undeclared path", () => {
    expect(resolveClientRequest("/albums").kind).toBe("notFound");
  });

  it("refuses a path that climbs out of the build directory", () => {
    // Containment before existence: a `..` that escaped must not be read,
    // whatever it points at. `package.json` is a real file one level up.
    expect(resolveClientRequest("/../package.json").kind).toBe("notFound");
    expect(resolveClientRequest("/..%2Fpackage.json").kind).toBe("notFound");
  });

  it("prefers a real file to the shell", () => {
    // Same precedence the cloud adapter applies. If the shell won, an asset
    // whose name collides with a client route would be answered with HTML and
    // the browser would report a module parse error.
    const built = existsSync(SHELL);
    expect(built, "run `pnpm build` before this test").toBe(true);
    const answer = resolveClientRequest("/index.html");
    expect(answer.kind).toBe("asset");
    if (answer.kind === "asset") expect(answer.file).toBe(join(DIST_DIR, "index.html"));
  });
});

describe("cache headers", () => {
  /** One content-hashed file the build actually emitted. */
  const hashed = (): string => {
    const names = readdirSync(join(DIST_DIR, "_immutable")).filter((n) => n.endsWith(".js"));
    expect(names.length, "run `pnpm build` before this test").toBeGreaterThan(0);
    return `/_immutable/${names[0]}`;
  };

  it("marks content-hashed output immutable", () => {
    // The prefix is what decides, not the file: `/_immutable/` is where the
    // build writes content-hashed names, and CloudFront's CachingOptimized
    // behavior is attached to that same prefix. The same split the platform's
    // web adapter applies to the deployed bundle.
    const answer = resolveClientRequest(hashed());
    expect(answer.kind).toBe("asset");
    if (answer.kind === "asset") {
      expect(answer.cacheControl).toBe("public, max-age=31536000, immutable");
      expect(answer.contentType).toBe("application/javascript; charset=utf-8");
    }
  });

  it("makes everything else revalidate", () => {
    // The shell is the one file whose contents change while its name does not,
    // so caching it forever would pin a browser to a build that no longer
    // exists.
    const answer = resolveClientRequest("/index.html");
    expect(answer.kind).toBe("asset");
    if (answer.kind === "asset") expect(answer.cacheControl).toBe("no-cache");
  });
});

describe("isClientRoute matches the manifest spelling", () => {
  it("matches a literal path exactly", () => {
    expect(isClientRoute("/sign-in")).toBe(true);
    expect(isClientRoute("/sign-in/")).toBe(false);
  });
});
