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

import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { FACE_MODELS, type VisionModel } from "../src/vision/models";
import { modelsDir } from "../src/vision/paths";

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
 * Download to a temp file, hashing the stream as it lands, and only `rename`
 * into place once the digest matches. A failed verify therefore leaves no file
 * behind that a later size check could mistake for a good one.
 */
async function fetchModel(model: VisionModel, dir: string): Promise<void> {
  const target = join(dir, model.fileName);
  if (alreadyPresent(target, model)) {
    console.log(`  ✓ ${model.fileName} — already installed (${mb(model.sizeBytes)})`);
    return;
  }

  console.log(`  ↓ ${model.fileName} (${mb(model.sizeBytes)}) — ${model.role}`);
  const res = await fetch(model.url);
  if (!res.ok || !res.body) {
    throw new Error(`GET ${model.url} → ${res.status} ${res.statusText}`);
  }

  const tmp = `${target}.download`;
  rmSync(tmp, { force: true });
  const hash = createHash("sha256");
  let seen = 0;
  let lastReport = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      seen += chunk.byteLength;
      // Progress on a 261 MB file over an unknown link is the difference
      // between "working" and "hung" — but one line per chunk is unreadable.
      if (seen - lastReport > 20 * 1024 * 1024) {
        lastReport = seen;
        process.stdout.write(`    ${mb(seen)} / ${mb(model.sizeBytes)}\n`);
      }
      done(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), tap, createWriteStream(tmp));
    const digest = hash.digest("hex");
    if (digest !== model.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${model.fileName}\n    expected ${model.sha256}\n    got      ${digest}`,
      );
    }
    renameSync(tmp, target);
    console.log(`    ✓ verified ${digest.slice(0, 16)}…`);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
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
