#!/usr/bin/env tsx
/**
 * `pnpm vision:tune-floor` — pick the search membership floor from evidence.
 *
 * The floor in `search/ranking.ts` decides whether a photo is a description match at
 * all, and §5.3 is right that no constant suits every phrasing. That makes it exactly
 * the kind of thing §11 says to settle by trying — so this is the trying, as a
 * repeatable action rather than a one-off investigation.
 *
 * Give it queries whose answers you know and it sweeps candidate floors, counting
 * errors each way:
 *
 *     pnpm vision:tune-floor                          # the built-in probe set
 *     pnpm vision:tune-floor "water=3" "a dog=1" "a pizza=0"
 *
 * `query=n` means "n photos in this library genuinely contain this". Absent concepts
 * (`=0`) matter as much as present ones: they are the only way to detect a floor that
 * admits noise, and a sweep with no negatives will always recommend zero.
 *
 * **Read the two columns as a trade, not a score.** False positives are junk in the
 * results; false negatives are photos you own and cannot find. The right floor is the
 * largest one that costs no recall — until a false negative starts annoying you more
 * than a false positive, at which point the table says what moving costs.
 *
 * ⚠ Imports the engine, so this is a script and never anything `app/` reaches.
 */

import { TextEngine } from "../src/vision/engine/siglip-text";
import { readSceneIndex, scoreAgainstIndex } from "../src/vision/scene-index";
import { searchModelStatus, SEARCH_TEXT_MODEL, SEARCH_TOKENIZER } from "../src/vision/models";
import { modelPath } from "../src/vision/paths";
import { promptVariants } from "../src/vision/search/search";
import { DEFAULT_DENSE_FLOOR } from "../src/vision/search/ranking";

/**
 * The default probe set, deliberately half absent.
 *
 * Counts are left blank for the present ones because only the operator knows them —
 * `people=?` prints the scores and asks rather than assuming.
 */
const DEFAULT_PROBES = [
  "a spaceship=0",
  "a plate of sushi=0",
  "a subway train=0",
  "a pizza=0",
  "a birthday cake=0",
  "a laptop=0",
  "a snowy mountain=0",
];

const FLOORS = [0, 0.02, 0.025, 0.03, 0.035, 0.04, 0.045, 0.05, 0.06];

function parseProbes(args: string[]): Array<{ query: string; truth: number }> {
  const raw = args.length > 0 ? args : DEFAULT_PROBES;
  return raw.map((entry) => {
    const at = entry.lastIndexOf("=");
    if (at < 0) throw new Error(`"${entry}" must be written query=count, e.g. "water=3"`);
    const truth = Number(entry.slice(at + 1));
    if (!Number.isInteger(truth) || truth < 0) {
      throw new Error(`"${entry}" has no whole-number count after "="`);
    }
    return { query: entry.slice(0, at), truth };
  });
}

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
  const models = searchModelStatus();
  if (!models.installed) {
    console.error(
      `The search models are not installed (missing ${models.missing.join(", ")}).\n` +
        `Run \`pnpm vision:fetch-models --search\`.`,
    );
    process.exit(1);
  }
  const index = readSceneIndex();
  if (!index || index.recordIds.length === 0) {
    console.error("No scene embeddings. Enable scene in Settings and run a scan first.");
    process.exit(1);
  }

  const probes = parseProbes(process.argv.slice(2));
  const engine = await TextEngine.create({
    textPath: modelPath(SEARCH_TEXT_MODEL.fileName),
    tokenizerPath: modelPath(SEARCH_TOKENIZER.fileName),
  });

  try {
    const rows: Array<{ query: string; truth: number; counts: number[]; top: number }> = [];
    for (const { query, truth } of probes) {
      // Ensembled exactly as the search path does, so the numbers transfer.
      const vector = meanUnit(await engine.embedAll(promptVariants(query)));
      const scores = scoreAgainstIndex(index, vector).map(([, s]) => s);
      rows.push({
        query,
        truth,
        counts: FLOORS.map((f) => scores.filter((s) => s >= f).length),
        top: scores[0] ?? 0,
      });
    }

    const width = Math.max(...rows.map((r) => r.query.length), 18);
    console.log(
      `\n${index.recordIds.length} photos · current floor ${DEFAULT_DENSE_FLOOR}\n`,
    );
    console.log(
      "query".padEnd(width) + " truth   top  " + FLOORS.map((f) => f.toFixed(3).padStart(7)).join(""),
    );
    for (const row of rows) {
      const cells = row.counts.map((c) => {
        const mark = c > row.truth ? "+" : c < row.truth ? "-" : " ";
        return `${c}${mark}`.padStart(7);
      });
      console.log(
        row.query.padEnd(width) +
          String(row.truth).padStart(6) +
          row.top.toFixed(3).padStart(6) +
          "  " +
          cells.join(""),
      );
    }

    const fp = FLOORS.map((_, i) => rows.reduce((a, r) => a + Math.max(0, r.counts[i] - r.truth), 0));
    const fn = FLOORS.map((_, i) => rows.reduce((a, r) => a + Math.max(0, r.truth - r.counts[i]), 0));
    console.log(`\n${"false positives".padEnd(width)}${" ".repeat(12)}${fp.map((n) => String(n).padStart(7)).join("")}`);
    console.log(`${"false negatives".padEnd(width)}${" ".repeat(12)}${fn.map((n) => String(n).padStart(7)).join("")}`);

    // The largest floor costing no recall — the right default while every observed
    // error is a false positive.
    let best = 0;
    for (let i = 0; i < FLOORS.length; i++) if (fn[i] === 0) best = i;
    console.log(
      `\nLargest floor with no false negatives: ${FLOORS[best].toFixed(3)} ` +
        `(${fp[best]} false positive${fp[best] === 1 ? "" : "s"} remaining)`,
    );
    if (probes.every((p) => p.truth === 0)) {
      console.log(
        `\nEvery probe was an absent concept, so "no false negatives" is free and the\n` +
          `recommendation above is meaningless. Add queries you *do* have photos for —\n` +
          `e.g. \`pnpm vision:tune-floor "water=3" "a dog=1" "a spaceship=0"\`.`,
      );
    }
    console.log(`\nSet it in Settings, or in config.json under \`search.denseFloor\`.`);
  } finally {
    await engine.dispose();
  }
}

await main();
