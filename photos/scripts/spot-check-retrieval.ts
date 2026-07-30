#!/usr/bin/env tsx
/**
 * `pnpm vision:spot-check` — does text-to-image retrieval actually work?
 *
 * The check the plan asks for and defers to measurement (§11: "settle by trying,
 * not by planning"). Everything else that has been tested so far verifies pieces
 * in isolation — the tokenizer against HuggingFace, the image tower's pairwise
 * structure, the index round-trip. None of it establishes the one property the
 * whole feature rests on:
 *
 *     **the text tower and the image tower embed into the same space.**
 *
 * If they do not — a wrong output tensor, a projection mismatch, a preprocessing
 * divergence — every cosine here is noise, and *nothing else would notice*. Search
 * would return confidently ordered results with no relationship to the query. So
 * this ranks real photographs against real English and prints the matrix.
 *
 * The fixtures are two portraits of one person and two photos of a four-person
 * group, which is enough to separate "one person" from "several people" and to
 * catch a dead cross-modal link. Point it at a real library for a real answer:
 *
 *     pnpm vision:spot-check
 *     pnpm vision:spot-check ~/Pictures/holiday/*.jpg
 *
 * ⚠ Imports both engines, so this is a script and never anything `app/` reaches.
 */

import { readFileSync, statSync } from "node:fs";
import { SceneEngine } from "../src/vision/engine/siglip";
import { TextEngine } from "../src/vision/engine/siglip-text";
import { cosineSimilarity } from "../src/vision/embeddings";
import {
  modelStatus,
  SCENE_IMAGE_MODEL,
  searchModelStatus,
  SEARCH_TEXT_MODEL,
  SEARCH_TOKENIZER,
} from "../src/vision/models";
import { modelPath } from "../src/vision/paths";
import { promptVariants } from "../src/vision/search/search";
import { fixturePath, VISION_FIXTURES } from "./lib/vision-fixtures";

/** Queries chosen to discriminate *between* the fixtures, not merely to describe them. */
const QUERIES = [
  "a portrait of a single person",
  "a group of several people",
  "a photograph of four people together",
  "one person looking at the camera",
  "a beach at sunset",
  "a plate of food",
  "a dog",
];

function images(): string[] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (args.length > 0) return args;
  return VISION_FIXTURES.map((f) => fixturePath(f.fileName)).filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function label(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Mean of unit vectors, re-normalized — the same ensembling `search.ts` applies. */
function meanUnit(vectors: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
  let sum = 0;
  for (const v of out) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

async function main(): Promise<void> {
  const scene = modelStatus("scene");
  const searchModels = searchModelStatus();
  if (!scene.installed || !searchModels.installed) {
    console.error(
      `Needs both towers.\n` +
        (scene.installed ? "" : `  missing image tower: ${scene.missing.join(", ")}\n`) +
        (searchModels.installed ? "" : `  missing search models: ${searchModels.missing.join(", ")}\n`) +
        `Run \`pnpm vision:fetch-models --scene --search\`.`,
    );
    process.exit(1);
  }

  const files = images();
  if (files.length === 0) {
    console.error("No images. Pass paths, or run `pnpm vision:fetch-fixtures`.");
    process.exit(1);
  }

  const imageEngine = await SceneEngine.create({
    imagePath: modelPath(SCENE_IMAGE_MODEL.fileName),
  });
  const textEngine = await TextEngine.create({
    textPath: modelPath(SEARCH_TEXT_MODEL.fileName),
    tokenizerPath: modelPath(SEARCH_TOKENIZER.fileName),
  });

  try {
    const imageVectors: Array<{ file: string; vector: Float32Array }> = [];
    for (const file of files) {
      const result = await imageEngine.embed(new Uint8Array(readFileSync(file)));
      imageVectors.push({ file, vector: result.embedding });
    }

    // Ensembled exactly as the search path does, so what is measured here is what
    // ships rather than an idealized version of it.
    const queryVectors = new Map<string, Float32Array>();
    for (const query of QUERIES) {
      const variants = await textEngine.embedAll(promptVariants(query));
      queryVectors.set(query, meanUnit(variants));
    }

    const width = Math.max(...QUERIES.map((q) => q.length));
    console.log(`\nCross-modal cosine — rows are queries, columns are images\n`);
    console.log(
      `${"".padEnd(width)}  ` + imageVectors.map((i) => label(i.file).padStart(16)).join(" "),
    );

    let sane = true;
    for (const query of QUERIES) {
      const vector = queryVectors.get(query)!;
      const scores = imageVectors.map((i) => cosineSimilarity(i.vector, vector));
      const best = Math.max(...scores);
      const cells = scores.map((s) => {
        const cell = s.toFixed(4).padStart(16);
        return s === best ? `\x1b[1m${cell}\x1b[0m` : cell;
      });
      console.log(`${query.padEnd(width)}  ${cells.join(" ")}`);
      // All-identical scores across visibly different photographs is the signature
      // of a broken cross-modal link.
      if (Math.max(...scores) - Math.min(...scores) < 1e-4) sane = false;
    }

    console.log(`\n${"—".repeat(60)}`);

    // The discriminating assertion, and the reason the query list is what it is:
    // "a portrait of a single person" must prefer a portrait over a group shot,
    // and "a group of several people" must prefer the reverse. That ordering is
    // only possible if both towers share a space.
    const portraits = imageVectors.filter((i) => label(i.file).startsWith("portrait"));
    const groups = imageVectors.filter((i) => label(i.file).startsWith("group"));
    if (portraits.length > 0 && groups.length > 0) {
      const check = (query: string, prefer: typeof portraits, over: typeof groups) => {
        const vector = queryVectors.get(query)!;
        const preferred = Math.max(...prefer.map((i) => cosineSimilarity(i.vector, vector)));
        const other = Math.max(...over.map((i) => cosineSimilarity(i.vector, vector)));
        const ok = preferred > other;
        console.log(
          `${ok ? "✓" : "✗"} ${query.padEnd(width)} ${preferred.toFixed(4)} vs ${other.toFixed(4)}`,
        );
        return ok;
      };
      const a = check("a portrait of a single person", portraits, groups);
      const b = check("a group of several people", groups, portraits);
      if (a && b) {
        console.log(`\n✓ Cross-modal retrieval discriminates. The towers share a space.`);
      } else {
        console.log(
          `\n✗ Retrieval did not discriminate as expected. Either the towers are not\n` +
            `  in the same space, or these fixtures do not separate these queries.\n` +
            `  Re-run against a real library before concluding it is a bug.`,
        );
        process.exitCode = 1;
      }
    }

    if (!sane) {
      console.log(
        `\n✗ Some query scored every image identically — that is what a dead\n` +
          `  cross-modal link looks like. Investigate before trusting search.`,
      );
      process.exitCode = 1;
    }

    console.log(
      `\nNote: absolute values run low and in a narrow band — SigLIP cosines are\n` +
        `uncalibrated, which is exactly why §5.1 min-max normalizes per query and\n` +
        `§5.3 refuses an absolute threshold. Only the ordering means anything.`,
    );
  } finally {
    await Promise.all([imageEngine.dispose(), textEngine.dispose()]);
  }
}

await main();
