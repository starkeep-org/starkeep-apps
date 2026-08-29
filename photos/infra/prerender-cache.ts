import { readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import type {
  CacheValue,
  IncrementalCache,
  WithLastModified,
} from "open-next/cache/incremental/types.js";

/**
 * A read-only incremental cache over the pages the build already rendered.
 *
 * ## What this replaces, and why the previous answer was half right
 *
 * This was `no-incremental-cache.ts`: a stub returning `{}` for every read,
 * written because OpenNext defaults to S3, this deployment gives it no bucket,
 * and the failed round trips were noisy enough to bury real errors. Silencing
 * them was right. Its reasoning for storing nothing was not:
 *
 *   "Photos' pages read per-user data through the proxy, so there is nothing
 *    here that would be correct to serve to a second request."
 *
 * True of a dynamic page, false of a prerendered one. `/` and `/sign-in` are
 * both in the prerender manifest — `/` is a `dynamic(..., { ssr: false })`
 * shell and `/sign-in` is a static form — and their finished HTML is emitted
 * at build time into `.open-next/cache/<BUILD_ID>/`. Neither contains a byte of
 * user data. Returning `{}` for them did not avoid serving one user's data to
 * another; it threw away the build's own output and made the Lambda perform a
 * full React server render of two static documents, on a request path with a
 * ten-second timeout and a seventh of a vCPU.
 *
 * So: serve what the build produced, store nothing new. `get` reads a file that
 * shipped inside the bundle; `set` and `delete` stay no-ops, which keeps the
 * property the stub was reaching for — nothing is ever written, and nothing can
 * cross between users, because the only readable entries are build artifacts
 * identical for everyone.
 *
 * ## Layout
 *
 * `build-bundle.ts` copies `.open-next/cache/<BUILD_ID>/` to `cache/` at the
 * root of the Lambda package, dropping the build-id level: one bundle ships
 * exactly one build, so a directory named after it only adds a lookup that can
 * disagree with itself. Keys arrive as page paths ("index", "sign-in") and the
 * files are `<key>.cache`, matching OpenNext's own S3 layout minus that level.
 *
 * The fetch cache (`isFetch`) has no build-time entries and answers empty.
 *
 * A miss is normal, not an error: any path that is not prerendered — every
 * `/api/*` route — lands here first and must fall through to a real render.
 */

/**
 * `/var/task` in Lambda. `process.cwd()` is the fallback for a local harness;
 * this override is only reachable through the OpenNext build, so the fallback
 * exists to keep the function total rather than because anything uses it.
 */
const ROOT = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
const CACHE_DIR = join(ROOT, "cache");

/**
 * Keys come from Next's own route paths, but this reads from disk, so treat
 * them as untrusted and refuse anything that escapes the cache directory
 * rather than relying on that. Same reasoning as the static-asset wrapper in
 * `build-bundle.ts`, and the same shape of check.
 */
function cacheFilePath(key: string): string | null {
  const file = join(CACHE_DIR, `${normalize(key)}.cache`);
  if (!file.startsWith(CACHE_DIR + "/")) return null;
  return file;
}

const incrementalCache: IncrementalCache = {
  name: "prerender-cache",

  async get<IsFetch extends boolean = false>(
    key: string,
    isFetch?: IsFetch,
  ): Promise<WithLastModified<CacheValue<IsFetch>>> {
    if (isFetch) return {};
    const file = cacheFilePath(key);
    if (!file) return {};
    try {
      const [body, stats] = await Promise.all([readFile(file, "utf8"), stat(file)]);
      return {
        value: JSON.parse(body) as CacheValue<IsFetch>,
        lastModified: stats.mtimeMs,
      };
    } catch {
      // ENOENT for every non-prerendered path, which is most of them. A parse
      // failure lands here too and is treated the same way: the page renders.
      return {};
    }
  },

  async set() {},
  async delete() {},
};

export default incrementalCache;
