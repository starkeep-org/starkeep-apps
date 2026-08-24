import type { IncrementalCache } from "open-next/cache/incremental/types.js";

/**
 * An incremental cache that stores nothing.
 *
 * OpenNext defaults to S3 and this deployment gives it no bucket, so every
 * server render logged two failed round trips ("No value provided for input
 * HTTP label: Bucket"). Non-fatal, on the critical path of every SSR, and
 * noisy enough to bury a real error — tracing one upload through the Photos
 * Lambda log meant filtering out two stack traces per request first.
 *
 * Not caching is the honest answer rather than a stopgap: Photos' pages read
 * per-user data through the proxy, so there is nothing here that would be
 * correct to serve to a second request. Pointing this at a real bucket would
 * buy a cache nothing could safely hit.
 *
 * Memo has carried this since it adopted the session layer; Photos was missed.
 */
const cache: IncrementalCache = {
  name: "no-incremental-cache",
  async get() {
    return {};
  },
  async set() {},
  async delete() {},
};

export default cache;
