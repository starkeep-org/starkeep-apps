/**
 * The mount the app is served under: `/apps/photos` in the cloud, `""` locally.
 *
 * Vite's `base` prefixes every asset URL the *build* emits, and `index.html`'s
 * own `href`s go through it. It does not touch raw `fetch()` / `EventSource` /
 * `location` — a bundler cannot see those strings — so a root-absolute
 * same-origin path like `/api/local-data/data/records` escapes the app
 * entirely and the API Gateway answers its default 404. Every such path goes
 * through `withBasePath`, and `__tests__/client-base-path.test.ts` is the scan
 * that keeps it that way.
 *
 * `STARKEEP_APP_BASE_PATH` under its own name, and one spelling everywhere:
 * `vite.config.ts` substitutes the literal into the browser bundle, and on the
 * server and under vitest the same expression reads the real environment.
 */
export const BASE_PATH = (process.env.STARKEEP_APP_BASE_PATH ?? "").replace(/\/+$/, "");

export function withBasePath(path: string): string {
  if (!BASE_PATH) return path;
  if (!path.startsWith("/")) return path;
  return BASE_PATH + path;
}

/**
 * The inverse: the pathname with the mount removed, so a cloud
 * `/apps/photos/sign-in` reads as `/sign-in`.
 *
 * `src/main.tsx` decides which of the two client routes to mount with this, so
 * the browser's routing decision and the server's `shellPaths` matching are
 * made against the same spelling of the path.
 */
export function appRelativePath(pathname: string): string {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    return pathname.slice(BASE_PATH.length) || "/";
  }
  return pathname || "/";
}
