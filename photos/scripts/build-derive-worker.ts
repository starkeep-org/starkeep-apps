#!/usr/bin/env tsx
/**
 * `pnpm derive:build-worker` — compile the derivation worker to
 * `.derivation/derive-worker.mjs`.
 *
 * `worker_threads` needs JavaScript and this app is TypeScript, so something
 * has to bridge that. Bundling is the option that also buys the property worth
 * having: the worker has exactly one entry point, reachable only by absolute
 * path, so open-next's dependency tracer walking in from a route can never
 * arrive at sharp.
 *
 * `pnpm dev` and `pnpm start` run this first, so it is not a step anyone has to
 * remember. It is cheap and needs sharp only at runtime, loaded from
 * `node_modules` like any other native dependency.
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = resolve(SCRIPTS_DIR, "..");
const OUT_FILE = join(PHOTOS_DIR, ".derivation", "derive-worker.mjs");

mkdirSync(dirname(OUT_FILE), { recursive: true });

await build({
  entryPoints: [join(PHOTOS_DIR, "src", "derivation", "engine", "derive-worker.ts")],
  outfile: OUT_FILE,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // Native modules cannot be bundled, and @starkeep/app-client reads
  // credentials off disk — both must resolve from node_modules at runtime.
  //
  // exifr is external for a subtler reason: it probes for `fs` and `zlib` at
  // load time to decide which reader to use, and bundled it finds neither and
  // prints "Couldn't load fs" on every start. It works either way — the EXIF
  // this worker reads comes from a buffer already in hand — but resolving it
  // normally is both quieter and closer to how it runs everywhere else.
  external: ["sharp", "@starkeep/app-client", "exifr"],
  logLevel: "info",
});

console.log(`Derivation worker → ${OUT_FILE}`);
