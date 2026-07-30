#!/usr/bin/env tsx
/**
 * `pnpm vision:fetch-models` — download the ONNX graphs the on-device vision
 * tasks need into `$STARKEEP_DIR/app-assets/photos/vision/models/`.
 *
 * 278 MB for faces and 1.7 GB for scene, which is why it is a script and not a
 * committed asset, and why the app runs in a "models not installed" state until
 * it has been run. `--faces` or `--scene` fetches just one.
 *
 * The acknowledgement is not ceremony. The antelopev2 *weights* are
 * non-commercial-research-only while InsightFace's code is MIT, and that
 * distinction is exactly the one that gets lost — a package that quietly
 * downloads them hands every user a restriction they never saw. So this asks,
 * once, and records the answer next to the files.
 *
 * It gates **faces only**. The scene weights are Apache-2.0, and making an
 * Apache-2.0 download conditional on accepting a non-commercial restriction would
 * misrepresent both licences.
 *
 * The Faces panel offers the same download for people who did not arrive from a
 * shell; both go through `verifiedDownload` and both record the acceptance the
 * same way. This remains the path for a headless or scripted install.
 */

import { mkdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { LICENCE_NOTICE, LICENCE_SUMMARY, writeLicenceAcknowledgement } from "../src/vision/licence";
import {
  SCENE_LICENCE_SUMMARY,
  SEARCH_MODELS,
  TASK_MODELS,
  type VisionModel,
} from "../src/vision/models";
import { modelsDir } from "../src/vision/paths";
import { verifiedDownload } from "../src/vision/verified-download";

const ACK_FLAG = "--accept-noncommercial-licence";

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

/**
 * The downloadable groups.
 *
 * Grouped by *what needs them* rather than by repository, and separated because
 * their licences differ: the antelopev2 acknowledgement must gate only the
 * weights it applies to, or accepting a non-commercial restriction becomes the
 * price of an Apache-2.0 download.
 *
 * `search` is not a vision task — the scan never opens the text tower — so it is
 * a group here rather than an entry in `TASK_MODELS`.
 */
const GROUPS = {
  faces: { models: TASK_MODELS.faces, licence: LICENCE_SUMMARY, needsAck: true },
  scene: { models: TASK_MODELS.scene, licence: SCENE_LICENCE_SUMMARY, needsAck: false },
  search: { models: SEARCH_MODELS, licence: SCENE_LICENCE_SUMMARY, needsAck: false },
} as const;

type GroupName = keyof typeof GROUPS;
const ALL_GROUPS = Object.keys(GROUPS) as GroupName[];

function requestedGroups(): GroupName[] {
  const only = ALL_GROUPS.filter((name) => process.argv.includes(`--${name}`));
  return only.length > 0 ? only : [...ALL_GROUPS];
}

async function main(): Promise<void> {
  const groups = requestedGroups();
  const dir = modelsDir();

  // Asked once, up front, and only if something being fetched needs it — so
  // `--scene` is never gated on a restriction that does not apply to it.
  if (groups.some((name) => GROUPS[name].needsAck)) {
    if (!(await acknowledge())) {
      const gated = groups.filter((name) => GROUPS[name].needsAck);
      console.error(`\nDeclined — skipping ${gated.join(", ")}.`);
      for (const name of gated) groups.splice(groups.indexOf(name), 1);
      if (groups.length === 0) process.exit(1);
    }
  }

  mkdirSync(dir, { recursive: true });

  for (const name of groups) {
    const { models, licence } = GROUPS[name];
    const total = models.reduce((sum, m) => sum + m.sizeBytes, 0);
    console.log(`\n${name} — ${mb(total)}, ${licence} → ${dir}\n`);
    for (const model of models) {
      await fetchModel(model, dir);
    }
  }

  if (groups.includes("faces")) {
    writeLicenceAcknowledgement("`pnpm vision:fetch-models`");
  }

  console.log(`\nDone: ${groups.join(", ")}. Enable what you want in the Photos Settings panel.`);
}

await main();
