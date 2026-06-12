import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPlatformStack } from "@starkeep/e2e";

/**
 * Boot the real platform once for the run: local-data-server + admin-web from
 * the sibling starkeep-core checkout (via the @starkeep/e2e harness, a link:
 * dependency). This repo's root is the app parent dir, so admin-web discovers
 * the photos app exactly as it would on an operator's machine. Drive's UI is
 * not needed here — shared-data assertions go through the LDS directly.
 */
export default async function globalSetup() {
  const appsRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const stack = await startPlatformStack({ appParentDirs: [appsRepoRoot], drive: false });
  process.env.E2E_LDS_URL = stack.lds.url;
  process.env.E2E_ADMIN_URL = stack.adminUrl;
  process.env.E2E_ADMIN_DATA_DIR = stack.adminDataDir;
  return async () => {
    // Keep the spawned app daemons' logs around for post-mortem — the stack's
    // temp data dir is deleted on stop.
    const logDir = resolve(dirname(fileURLToPath(import.meta.url)), "test-results");
    try {
      const pidsDir = join(stack.adminDataDir, "pids");
      await mkdir(logDir, { recursive: true });
      for (const entry of await readdir(pidsDir)) {
        if (entry.endsWith(".log")) await copyFile(join(pidsDir, entry), join(logDir, entry));
      }
    } catch {
      /* no daemons were started */
    }
    await stack.stop();
  };
}
