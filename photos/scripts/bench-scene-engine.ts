#!/usr/bin/env tsx
/**
 * `pnpm vision:bench-scene` — how fast is the scene image tower, really?
 *
 * Exists because the model choice (see `vision-model-choice.md`) traded compute
 * for retrieval quality deliberately, and the size of that trade was an
 * *estimate*: 576 patches at 384 px through a ~400 M-parameter fp32 tower, which
 * is roughly 35× ViT-B/32 on paper. Paper is not a throughput number, and the
 * difference between "an hour" and "overnight" for a first pass is the kind of
 * thing a user should be told before they enable the toggle rather than discover
 * at photo 400.
 *
 * Reports seconds per image and extrapolates to library sizes, so the decision to
 * keep fp32 — or to drop to the int8 tower, or to a smaller SigLIP variant — is
 * made against a measurement.
 *
 * Runs against whatever images it is pointed at:
 *
 *     pnpm vision:bench-scene                    # the test fixtures
 *     pnpm vision:bench-scene ~/Pictures/*.jpg   # real photos, which is better
 *
 * Fixtures are portraits and therefore not representative of a real library's
 * mix of resolutions — the tower resizes everything to 384² so inference cost is
 * flat, but *decode* cost is not, and a 48 MP phone photo decodes far slower than
 * a 1 MP fixture. Point it at real photos when the answer matters.
 *
 * ⚠ Imports the engine, so this is a script and never anything `app/` reaches.
 */

import { readFileSync, statSync } from "node:fs";
import { SceneEngine } from "../src/vision/engine/siglip";
import { cosineSimilarity } from "../src/vision/embeddings";
import { modelStatus, SCENE_IMAGE_MODEL, SCENE_EMBEDDING_DIM } from "../src/vision/models";
import { modelPath } from "../src/vision/paths";
import { fixturePath, VISION_FIXTURES } from "./lib/vision-fixtures";

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

function extrapolate(perImageMs: number, count: number): string {
  const total = perImageMs * count;
  const hours = total / 3_600_000;
  return hours < 1 ? `${(total / 60_000).toFixed(0)} min` : `${hours.toFixed(1)} h`;
}

function inputs(): string[] {
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

async function main(): Promise<void> {
  const status = modelStatus("scene");
  if (!status.installed) {
    console.error(
      `The scene image tower is not installed (missing ${status.missing.join(", ")}).\n` +
        `Run \`pnpm vision:fetch-models --scene\` first.`,
    );
    process.exit(1);
  }

  const files = inputs();
  if (files.length === 0) {
    console.error(
      "No images to benchmark. Pass paths, or run `pnpm vision:fetch-fixtures` for the test set.",
    );
    process.exit(1);
  }

  console.log(`Model  ${SCENE_IMAGE_MODEL.fileName} (${(SCENE_IMAGE_MODEL.sizeBytes / 1e9).toFixed(2)} GB, fp32)`);

  // Session creation is timed separately: it is paid once per scan pass, not per
  // image, so folding it into the mean would overstate a long pass and understate
  // a short one.
  const loadStart = performance.now();
  const engine = await SceneEngine.create({ imagePath: modelPath(SCENE_IMAGE_MODEL.fileName) });
  console.log(`Load   ${seconds(performance.now() - loadStart)} (once per pass)\n`);

  try {
    const timings: number[] = [];
    const embeddings: Array<{ file: string; vector: Float32Array }> = [];

    for (const file of files) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(file));
      } catch (err) {
        console.warn(`  skipped ${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const start = performance.now();
      const result = await engine.embed(bytes);
      const elapsed = performance.now() - start;
      timings.push(elapsed);
      embeddings.push({ file, vector: result.embedding });
      console.log(
        `  ${seconds(elapsed).padStart(8)}  ${result.width}×${result.height}  ${file.split("/").pop()}`,
      );
    }

    if (timings.length === 0) {
      console.error("\nNothing was embedded.");
      process.exit(1);
    }

    // The first inference pays ORT's graph warm-up, so it is reported but kept out
    // of the mean — a scan of 10 k photos pays it once.
    const warm = timings.length > 1 ? timings.slice(1) : timings;
    const mean = warm.reduce((a, b) => a + b, 0) / warm.length;
    const sorted = [...warm].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    console.log(`\n${"—".repeat(60)}`);
    console.log(`Images        ${timings.length} (first excluded from the mean as warm-up)`);
    console.log(`Mean          ${seconds(mean)}/image`);
    console.log(`Median        ${seconds(median)}/image`);
    console.log(`Throughput    ${(60_000 / mean).toFixed(1)} images/min`);
    console.log(`\nFirst pass, extrapolated at the mean:`);
    for (const n of [1_000, 5_000, 10_000, 50_000]) {
      console.log(`  ${n.toLocaleString().padStart(6)} photos   ${extrapolate(mean, n)}`);
    }

    // A cheap sanity check that the embeddings mean something, rather than being
    // 1152 plausible numbers. Distinct photos must not be near-identical, and
    // every vector must be unit length — if preprocessing is wrong (ImageNet
    // normalization, or a centre crop) this still "works" and quietly degrades,
    // so it is a smoke test and not a correctness proof.
    console.log(`\nSanity:`);
    for (const { file, vector } of embeddings) {
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
      if (vector.length !== SCENE_EMBEDDING_DIM || Math.abs(norm - 1) > 1e-3) {
        console.log(`  ✗ ${file.split("/").pop()}: ${vector.length}-d, ‖v‖=${norm.toFixed(4)}`);
      }
    }
    console.log(`  ✓ ${embeddings.length} unit-length ${SCENE_EMBEDDING_DIM}-d vectors`);

    // The pairwise *spread*, not just the maximum. A high maximum alone proves
    // nothing — contrastive embeddings sit in a narrow cone, so absolute cosines
    // run high (§5.1's whole reason for per-query normalization). What would
    // indicate broken preprocessing is a *collapsed* spread: every pair equally
    // similar means the tower is seeing essentially the same input every time.
    if (embeddings.length > 1) {
      const pairs: Array<{ sim: number; label: string }> = [];
      for (let i = 0; i < embeddings.length; i++) {
        for (let j = i + 1; j < embeddings.length; j++) {
          pairs.push({
            sim: cosineSimilarity(embeddings[i].vector, embeddings[j].vector),
            label: `${embeddings[i].file.split("/").pop()} ~ ${embeddings[j].file.split("/").pop()}`,
          });
        }
      }
      pairs.sort((a, b) => b.sim - a.sim);
      const spread = pairs[0].sim - pairs[pairs.length - 1].sim;
      console.log(`  pairwise cosine  ${pairs[pairs.length - 1].sim.toFixed(3)} … ${pairs[0].sim.toFixed(3)}  (spread ${spread.toFixed(3)})`);
      for (const p of pairs) console.log(`    ${p.sim.toFixed(3)}  ${p.label}`);
      if (spread < 0.02) {
        console.log(
          `  ✗ collapsed spread — every pair is equally similar, which is what a\n` +
            `    preprocessing bug (wrong normalization, or a resize that discards\n` +
            `    the image) looks like. Investigate before trusting a scan.`,
        );
      }
    }

    console.log(
      `\nRetrieval quality is a separate question and needs the text tower —\n` +
        `that spot-check arrives with search (plan §5, step 3).`,
    );
  } finally {
    await engine.dispose();
  }
}

await main();
