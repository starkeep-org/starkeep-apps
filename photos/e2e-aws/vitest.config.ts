import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Photos' tier-3 runner. The journey is one ordered sequence against a real AWS
 * account, so the shape matches core's: serial, bail on the first failure, and
 * timeouts sized in tens of minutes because individual steps (Pulumi up, a
 * cloud bundle, a local app build) take that long.
 */
export default defineConfig({
  // The journey's member steps import admin-web's Users routes straight out of
  // the sibling starkeep-core checkout. Vite loads nothing outside this
  // workspace unless allowed, and refuses the file as "Cannot find module".
  server: { fs: { allow: [resolve(__dirname, "../.."), resolve(__dirname, "../../../starkeep-core")] } },
  test: {
    // Relative to this config's directory, which is where the journey lives.
    dir: __dirname,
    include: ["*.test.ts"],
    fileParallelism: false,
    bail: 1,
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 30 * 60 * 1000,
    // STARKEEP_AWS_TESTS unset → the suite self-skips; that's a pass.
    passWithNoTests: true,
  },
});
