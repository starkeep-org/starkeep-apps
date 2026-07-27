/**
 * `pnpm index-once` — run a single indexing pass and report what happened.
 *
 * Deliberately not a daemon. This app is a test consumer for the cross-app
 * label mechanism; a long-running watcher would add lifecycle concerns that
 * have nothing to do with what it is here to exercise.
 */

import { loadAppCredentials } from "@starkeep/app-client";
import { APP_ID, fetcherFor, runIndexPass } from "./index-pass.js";

async function main(): Promise<void> {
  const creds = await loadAppCredentials(APP_ID);
  if (!creds) {
    throw new Error(
      `no credentials for "${APP_ID}" — install the app from admin-web first`,
    );
  }
  const result = await runIndexPass(fetcherFor(creds));
  console.log(
    `[${APP_ID}] scanned ${result.scanned}, labelled ${result.labelled}, ` +
      `skipped ${result.skipped} (no faces)`,
  );
}

main().catch((err) => {
  console.error(`[${APP_ID}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
