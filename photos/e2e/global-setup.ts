import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPlatformStack } from "@starkeep/e2e";

/**
 * Boot the real platform once for the run: local-data-server + admin-web from
 * the sibling starkeep-core checkout (via the @starkeep/e2e harness, a link:
 * dependency). This repo's root is the app parent dir, so admin-web discovers
 * the photos app exactly as it would on an operator's machine.
 *
 * Drive's UI is booted because the platform-flows suite reads cross-app
 * visibility through it — what a *different* app sees of Photos' shared records
 * is a claim best made against the real second app rather than against the data
 * plane underneath it. The app-functionality suite goes to the LDS directly and
 * does not need it.
 */
export default async function globalSetup() {
  const appsRepoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const stack = await startPlatformStack({ appParentDirs: [appsRepoRoot] });
  process.env.E2E_LDS_URL = stack.lds.url;
  process.env.E2E_ADMIN_URL = stack.adminUrl;
  process.env.E2E_ADMIN_DATA_DIR = stack.adminDataDir;
  process.env.E2E_DRIVE_URL = stack.driveUrl ?? "";
  return async () => {
    // Keep the spawned app daemons' logs around for post-mortem — the stack's
    // temp data dir is deleted on stop.
    const logDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "test-results",
    );
    try {
      const pidsDir = join(stack.adminDataDir, "pids");
      await mkdir(logDir, { recursive: true });
      for (const entry of await readdir(pidsDir)) {
        if (entry.endsWith(".log"))
          await copyFile(join(pidsDir, entry), join(logDir, entry));
      }
    } catch {
      /* no daemons were started */
    }
    await stack.stop();
  };
}
