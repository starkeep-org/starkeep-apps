// Next.js's `basePath` config prefixes routes, <Link> hrefs, and asset URLs,
// but it does NOT transform raw `fetch()` calls. In the cloud deploy the app
// is mounted under /apps/photos, so root-relative fetches like
// `/api/photos` would bypass the app entirely. Use `withBasePath` for any
// absolute path that should resolve to this app.
export const BASE_PATH = process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH ?? "";

export function withBasePath(path: string): string {
  if (!BASE_PATH) return path;
  if (!path.startsWith("/")) return path;
  return BASE_PATH + path;
}
