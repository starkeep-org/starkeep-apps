/**
 * What the local surface answers from the built client, decided without
 * reading anything.
 *
 * Its own module rather than part of `src/serve.ts`, because `serve.ts` is a
 * process entry: importing it starts a server and an ingest watch. The decision
 * is the part worth testing, and the order it makes is the part worth pinning —
 * a real file wins over the shell, which is the same precedence the platform's
 * web adapter applies in the cloud.
 */

import { statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_ROUTES } from "./client-routes.js";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_DIR = join(PKG_DIR, "dist");
export const SHELL = join(DIST_DIR, "index.html");

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Does this path belong to the client?
 *
 * The manifest spelling: a literal path, or a `/prefix/*` glob. Same list and
 * same matching the cloud adapter applies to `shellPaths`, so the two surfaces
 * agree on which paths are the shell's — and an undeclared client route fails
 * here the way it fails in the cloud, rather than being caught by a development
 * server's blanket SPA fallback and found after a deploy.
 */
export function isClientRoute(pathname: string): boolean {
  return CLIENT_ROUTES.some((route) =>
    route.endsWith("/*") ? pathname.startsWith(route.slice(0, -1)) : pathname === route,
  );
}

/** What the built client answers a path with. */
export type ClientAnswer =
  | { kind: "asset"; file: string; contentType: string; cacheControl: string }
  | { kind: "shell"; file: string }
  | { kind: "notFound" };

export function resolveClientRequest(pathname: string): ClientAnswer {
  const candidate = join(DIST_DIR, normalize(decodeURIComponent(pathname)));
  // Containment first: a `..` that climbed out of the build must not be read,
  // whatever it points at.
  //
  // `isFile`, not "exists": `/` joins to the build directory itself, and
  // reading a directory throws EISDIR — which was a 500 on the app's own front
  // page, where the shell is the answer.
  if (candidate.startsWith(DIST_DIR + sep) && isFile(candidate)) {
    const dot = candidate.lastIndexOf(".");
    return {
      kind: "asset",
      file: candidate,
      contentType: MIME[candidate.slice(dot).toLowerCase()] ?? "application/octet-stream",
      // Content-hashed output is cacheable forever; everything else must
      // revalidate, because the shell is the one file whose contents change
      // while its name does not. The same split the platform's web adapter
      // applies to the deployed bundle, which is why the prefix matches.
      cacheControl: pathname.startsWith("/_immutable/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
  }
  if (isClientRoute(pathname)) return { kind: "shell", file: SHELL };
  return { kind: "notFound" };
}
