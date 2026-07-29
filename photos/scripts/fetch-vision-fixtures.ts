#!/usr/bin/env tsx
/**
 * `pnpm vision:fetch-fixtures` — download the photographs the engine
 * integration test runs against.
 *
 * The manifest, and what each file is for, lives in `lib/vision-fixtures.ts`.
 * Without them `__tests__/vision-engine.integration.test.ts` skips; the models
 * (`pnpm vision:fetch-models`) are the other half of what it needs.
 */

import { mkdirSync, statSync } from "node:fs";
import { fixturePath, fixturesDir, VISION_FIXTURES } from "./lib/vision-fixtures";
import { verifiedDownload } from "../src/vision/verified-download";

async function main(): Promise<void> {
  const dir = fixturesDir();
  mkdirSync(dir, { recursive: true });
  console.log(`\nInstalling engine test fixtures into ${dir}\n`);
  console.log(`  These are US federal government works in the public domain.\n`);

  for (const fixture of VISION_FIXTURES) {
    const target = fixturePath(fixture.fileName);
    try {
      if (statSync(target).size > 0) {
        console.log(`  ✓ ${fixture.fileName} — already present`);
        continue;
      }
    } catch {
      /* not there yet */
    }
    console.log(`  ↓ ${fixture.fileName} — ${fixture.role}`);
    const digest = await verifiedDownload({ url: fixture.url, target, sha256: fixture.sha256 });
    console.log(`    ✓ verified ${digest.slice(0, 16)}…`);
  }

  console.log(`\nDone. With the models installed, \`pnpm test\` now runs the engine test.`);
}

await main();
