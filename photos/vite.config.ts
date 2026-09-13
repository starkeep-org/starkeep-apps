import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Photos' browser half.
 *
 * Two build-time facts reach the bundle from here, and both were environment
 * variables the previous framework mirrored under a `NEXT_PUBLIC_` name:
 *
 *   - `STARKEEP_APP_BASE_PATH` is the mount the installer chooses,
 *     `/apps/photos` in the cloud and empty locally. It sets Vite's `base`, so
 *     every asset URL the build emits already carries it, and it is defined
 *     into the client so `withBasePath` can prefix the URLs no bundler sees —
 *     `fetch`, `EventSource`, `location`.
 *   - `STARKEEP_FORCE_REMOTE` says the build is the cloud one, which is what
 *     `AuthGate`, the toolbar's cloud-setup button and the vision guard key
 *     off.
 *
 * They are `define`d under their own names rather than through
 * `import.meta.env` so one spelling covers the browser bundle, the Node server
 * half and the tests: `define` is a literal substitution in the client build,
 * and in the server and in vitest the same expression reads the real
 * environment. `src/vision/remote.ts` is why that matters: it runs on the
 * server, keys off the cloud *build* flag as one of its two signals, and is
 * exercised by tests that stub the variable rather than rebuild.
 *
 * No Tailwind plugin and no CSS entry: Photos styles inline.
 */
const basePath = (process.env.STARKEEP_APP_BASE_PATH ?? "").replace(/\/+$/, "");

/**
 * The cloud build, which `infra/build-bundle.ts` marks by setting this. The
 * local build leaves it empty. Read here for one reason only — see
 * `build.sourcemap` below.
 */
const isCloudBuild = process.env.STARKEEP_FORCE_REMOTE === "true";

// Above Vite's default browser baseline, and stated in all three places it is
// asked for — `build.target` alone leaves dependency pre-bundling in
// development on the default, which is a separate esbuild pass.
const BROWSER_TARGET = "es2022";

export default defineConfig({
  plugins: [react()],
  // Vite wants the trailing slash; the platform states the mount without one.
  base: basePath ? `${basePath}/` : "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    "process.env.STARKEEP_APP_BASE_PATH": JSON.stringify(basePath),
    "process.env.STARKEEP_FORCE_REMOTE": JSON.stringify(
      process.env.STARKEEP_FORCE_REMOTE ?? "",
    ),
  },
  esbuild: { target: BROWSER_TARGET },
  optimizeDeps: { esbuildOptions: { target: BROWSER_TARGET } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: BROWSER_TARGET,
    // The platform's reserved prefix for content-addressed output: everything
    // Vite writes here is content-hashed, which is what earns it CloudFront's
    // CachingOptimized behavior while the rest of the app must revalidate.
    assetsDir: "_immutable",
    // Local only. `_immutable` is a public path, so a map shipped to the cloud
    // is served to anyone who asks for it, and Photos' original sources go with
    // it. It is also 1.4 MB of a 12.7 MB `dist.zip`, all of it to serve a
    // debugger nobody attaches to a Lambda. Locally the cost is a larger `dist/`
    // on the operator's own disk, which buys a readable stack trace.
    sourcemap: !isCloudBuild,
  },
});
