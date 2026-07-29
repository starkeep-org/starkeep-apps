#!/usr/bin/env tsx
/**
 * `pnpm vision:build-worker` — compile the scan worker to
 * `.vision/scan-worker.mjs`.
 *
 * `worker_threads` needs JavaScript, and this app is TypeScript, so something
 * has to bridge that. Bundling is the option that also buys the property the
 * plan actually cares about: the engine has exactly one entry point, reachable
 * only by absolute path, so open-next's tracer walking in from a route can never
 * arrive at `onnxruntime-node`.
 *
 * `pnpm dev` and `pnpm start` run this first, so it is not a step anyone has to
 * remember. It is cheap (a few hundred ms) and needs neither ORT nor sharp
 * installed — both stay external, loaded from `node_modules` at runtime like any
 * other native dependency.
 */

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = resolve(SCRIPTS_DIR, "..");
const OUT_FILE = join(PHOTOS_DIR, ".vision", "scan-worker.mjs");

mkdirSync(dirname(OUT_FILE), { recursive: true });

await build({
  entryPoints: [join(PHOTOS_DIR, "src", "vision", "engine", "scan-worker.ts")],
  outfile: OUT_FILE,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // Native modules cannot be bundled, and @starkeep/app-client reads credentials
  // off disk — all three must resolve from node_modules at runtime.
  external: ["onnxruntime-node", "sharp", "@starkeep/app-client"],
  logLevel: "info",
});

console.log(`Vision worker → ${OUT_FILE}`);
