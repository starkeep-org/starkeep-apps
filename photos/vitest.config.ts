import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The test config re-uses the build's resolver, which is why Vite was chosen
 * over a bundler that would have left `@/` meaning one thing to the build and
 * another to the tests.
 *
 * It deliberately does *not* re-use `vite.config.ts`'s `define` block. The two
 * build-time constants are `process.env` reads, so a test that needs a cloud
 * build sets the variable (`vi.stubEnv`) and gets the same expression to
 * resolve — which is what lets one test file cover both surfaces.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.{ts,tsx}"],
    env: {
      // A throwaway state directory. The routing tests drive the real signing
      // proxy, which loads the app credential from `$STARKEEP_DIR/app-creds`,
      // and the platform refuses to read the operator's own `~/.starkeep`
      // under a test runner — correctly, and loudly, on every run. Pointing it
      // somewhere empty is what makes the refusal unnecessary.
      STARKEEP_DIR: join(tmpdir(), "photos-vitest-starkeep"),
    },
  },
});
