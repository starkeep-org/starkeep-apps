import type { TagCache } from "open-next/cache/tag/types.js";

/**
 * A tag cache that knows about no tags.
 *
 * OpenNext defaults this to DynamoDB and this deployment gives it no table, so
 * every server render issued two DynamoDB queries with `TableName: null`,
 * waited for both to fail validation, and logged the stack traces:
 *
 *   ValidationException: Value null at 'tableName' failed to satisfy constraint
 *   Failed to get revalidated tags / Failed to get tags by path
 *
 * Measured at ~2.6 s on a cold container and ~1 s warm, on the critical path of
 * every page render. Exactly the shape the incremental-cache override was
 * written to fix (see `prerender-cache.ts`), in the sibling that was missed:
 * OpenNext has two cache overrides, only one was ever set, and the other kept
 * its default.
 *
 * Not caching is the honest answer rather than a stopgap. Tags exist to let
 * `revalidateTag` and `revalidatePath` invalidate a shared render cache; Photos
 * calls neither, and the only entries the incremental cache serves are the
 * pages the build already rendered, which nothing can invalidate short of a
 * redeploy. There is no state here for a table to hold.
 *
 * `getLastModified` must return the caller's own `lastModified` rather than
 * -1. -1 is OpenNext's "this entry has been revalidated, re-render it" signal
 * (see cache.cjs → getIncrementalCache, which returns null on -1), so a stub
 * answering -1 would silently disable the prerender cache this pairs with.
 */
const tagCache: TagCache = {
  name: "no-tag-cache",
  async getByTag() {
    return [];
  },
  async getByPath() {
    return [];
  },
  async getLastModified(_key: string, lastModified?: number) {
    return lastModified ?? Date.now();
  },
  async writeTags() {},
};

export default tagCache;
