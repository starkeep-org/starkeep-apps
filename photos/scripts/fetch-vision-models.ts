#!/usr/bin/env tsx
/**
 * `pnpm vision:fetch-models` — download the antelopev2 ONNX graphs the
 * on-device face task needs into `$STARKEEP_DIR/app-local/photos/vision/models/`.
 *
 * 278 MB, which is why it is a script and not a committed asset, and why the
 * app runs in a "models not installed" state until it has been run.
 *
 * The acknowledgement is not ceremony. The antelopev2 *weights* are
 * non-commercial-research-only while InsightFace's code is MIT, and that
 * distinction is exactly the one that gets lost — a package that quietly
 * downloads them hands every user a restriction they never saw. So this asks,
 * once, and records the answer next to the files.
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { FACE_MODELS, type VisionModel } from "../src/vision/models";
import { modelsDir } from "../src/vision/paths";
import { verifiedDownload } from "./lib/verified-download";

const ACK_FLAG = "--accept-noncommercial-licence";
const ACK_FILE = "LICENCE-ACKNOWLEDGED.txt";

const LICENCE_NOTICE = `
  The antelopev2 models come from InsightFace. Its *code* is MIT-licensed, but
  the training data and the pretrained weights — antelopev2 included — are
  released for NON-COMMERCIAL RESEARCH USE ONLY.

    https://github.com/deepinsight/insightface
    https://github.com/deepinsight/insightface/issues/2022

  Downloading them means you accept that restriction. Starkeep does not
  redistribute these weights and does not fetch them without this step.
`;

async function acknowledge(): Promise<boolean> {
  if (process.argv.includes(ACK_FLAG)) return true;
  console.log(LICENCE_NOTICE);
  if (!process.stdin.isTTY) {
    console.error(
      `Non-interactive shell — re-run with ${ACK_FLAG} to accept the licence terms above.`,
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("  Accept and download? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Already there and the right size? Then it was verified on the run that put it there. */
function alreadyPresent(path: string, model: VisionModel): boolean {
  try {
    return statSync(path).size === model.sizeBytes;
  } catch {
    return false;
  }
}

/**
 * The verification itself lives in `lib/verified-download.ts` — this only adds
 * progress reporting, because on a 261 MB file over an unknown link that is the
 * difference between "working" and "hung".
 */
async function fetchModel(model: VisionModel, dir: string): Promise<void> {
  const target = join(dir, model.fileName);
  if (alreadyPresent(target, model)) {
    console.log(`  ✓ ${model.fileName} — already installed (${mb(model.sizeBytes)})`);
    return;
  }

  console.log(`  ↓ ${model.fileName} (${mb(model.sizeBytes)}) — ${model.role}`);
  let lastReport = 0;
  const digest = await verifiedDownload({
    url: model.url,
    target,
    sha256: model.sha256,
    onProgress: (seen) => {
      // One line per chunk is unreadable; one per 20 MB is a progress bar.
      if (seen - lastReport > 20 * 1024 * 1024) {
        lastReport = seen;
        process.stdout.write(`    ${mb(seen)} / ${mb(model.sizeBytes)}\n`);
      }
    },
  });
  console.log(`    ✓ verified ${digest.slice(0, 16)}…`);
}

async function main(): Promise<void> {
  if (!(await acknowledge())) {
    console.error("\nDeclined — no models downloaded.");
    process.exit(1);
  }

  const dir = modelsDir();
  mkdirSync(dir, { recursive: true });
  console.log(`\nInstalling face models into ${dir}\n`);

  for (const model of FACE_MODELS) {
    await fetchModel(model, dir);
  }

  writeFileSync(
    join(dir, ACK_FILE),
    `antelopev2 weights: non-commercial research use only (InsightFace).\n` +
      `Acknowledged ${new Date().toISOString()} by \`pnpm vision:fetch-models\`.\n` +
      `${LICENCE_NOTICE.trim()}\n`,
    "utf-8",
  );

  console.log(`\nDone. Enable face detection in the Photos Settings panel.`);
}

await main();
