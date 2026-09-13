#!/usr/bin/env tsx
/**
 * Build the Photos Lambda bundle (dist.zip) for cloud install.
 *
 * App-owned half of the install contract. The platform installer
 * (@starkeep/admin-installer cli:install-app) invokes this via `pnpm bundle` in
 * the app's source dir and consumes the resulting zip:
 *
 *   env in:  STARKEEP_APP_BASE_PATH = /apps/photos   (route prefix to bake in)
 *            STARKEEP_BUNDLE_OUT    = <abs path>     (where to write dist.zip)
 *   out:     dist.zip at STARKEEP_BUNDLE_OUT
 *
 * Four steps: build the browser half with Vite straight into the staging
 * directory, bundle the two Lambda entries with esbuild, install sharp for the
 * Lambda's platform, and zip.
 *
 * What that replaced was a framework repair kit. An OpenNext server function
 * staged by hand with `verbatimSymlinks` for pnpm's virtual store; forty lines
 * of `.nft.json` trace-copying because the bundler never traced the
 * instrumentation hook's chunks, whose absence answered every request —
 * including the sign-in page — with `{"message":"Server failed to respond."}`;
 * a prerender cache shipped because the deployment provisions no bucket for
 * one; a null tag cache to switch off a backend the install never creates; and
 * a sweep of 3.3 MB of build inputs the recursive copy had dragged in. None of
 * it has a counterpart here, because the shell is a file and the server is one
 * Hono app.
 *
 * **esbuild bundles where the tracer copied**, and that is the one thing this
 * script is now stricter about than its predecessor. The tracer walked a graph
 * and copied what it found; esbuild inlines eagerly, so a single import of the
 * vision engine from a route would pull `onnxruntime-node` — 270 MB unpacked —
 * into a Lambda that serves HTML. `__tests__/worker-bundle-isolation.test.ts`
 * is the guard, and the size check at the end of this file is the backstop.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const INFRA_DIR = dirname(fileURLToPath(import.meta.url)); // .../photos/infra
const PHOTOS_DIR = resolve(INFRA_DIR, ".."); // .../photos

/**
 * The manifest is the single declaration of which public paths the bundle
 * answers from disk. Reading it here rather than repeating the list in the
 * entry is what lets `@starkeep/admin-manifest` check the list against
 * `publicPaths` — a hand-written copy is checkable only by a test that greps
 * this file.
 */
const manifest = JSON.parse(
  readFileSync(join(PHOTOS_DIR, "starkeep.manifest.json"), "utf8"),
) as {
  infraRequirements: {
    compute: { handlers: Array<{ name: string; staticAssetPaths?: string[] }> };
  };
};

const APP_BASE_PATH = process.env.STARKEEP_APP_BASE_PATH;
if (!APP_BASE_PATH) {
  console.error("Error: STARKEEP_APP_BASE_PATH env var is required (e.g. /apps/photos).");
  process.exit(1);
}
const BUNDLE_OUT = process.env.STARKEEP_BUNDLE_OUT;
if (!BUNDLE_OUT) {
  console.error("Error: STARKEEP_BUNDLE_OUT env var is required (abs path to write dist.zip).");
  process.exit(1);
}

// The static branch runs ahead of the app's own gate, so anything it answers is
// answered without one. An empty list is refused rather than shipped, because a
// bundle that serves no shell and no chunks renders a blank page and reports
// nothing.
const staticHandler = manifest.infraRequirements.compute.handlers.find((h) => h.name === "static");
if (!staticHandler) {
  console.error("photos manifest has no `static` compute handler.");
  process.exit(1);
}
if ((staticHandler.staticAssetPaths ?? []).length === 0) {
  console.error(
    "photos manifest declares no `staticAssetPaths` on the `static` handler, so the bundle " +
      "would answer neither the shell nor any asset and every page would render blank; " +
      "refusing to build that bundle.",
  );
  process.exit(1);
}

/**
 * What the browser-facing Lambda must never contain, in bytes.
 *
 * `onnxruntime-node` alone is ~270 MB unpacked and Lambda's own hard ceiling is
 * 250 MB unzipped, so a bundle that swallowed it could not deploy at all — but
 * it would fail at the deploy with an AWS error rather than here with a reason.
 * The threshold is set well above what the entry legitimately weighs (Hono plus
 * `@starkeep/app-client`, under a megabyte) and well below anything that could
 * be an accident.
 */
const MAX_STATIC_ENTRY_BYTES = 8 * 1024 * 1024;

/** [major, minor, patch] of a version string, for ordering comparisons. */
function versionParts(version: string): [number, number, number] {
  const [major, minor, patch] = version
    .split("-")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

/** Lowest version a `^x.y.z` / `>=x.y.z` / `x.y.z` range accepts. */
function rangeFloor(range: string): string | undefined {
  return /^[\^~>=]*\s*(\d+\.\d+\.\d+)/.exec(range.trim())?.[1];
}

/**
 * Exact sharp version to pin the Lambda's install to: the one the photos
 * workspace actually has installed, so the resize handler runs the same sharp
 * the app is built and tested against.
 *
 * Read from the installed package rather than the `^x.y.z` range in
 * package.json because the range is still floating. Note this repo gitignores
 * pnpm-lock.yaml, so "installed" means whatever the last `pnpm install` on this
 * machine resolved — hence the floor check below, which turns a node_modules
 * tree that has fallen behind package.json into a loud failure instead of a
 * bundle that silently ships an old sharp.
 */
function resolveSharpVersion(): string {
  const require = createRequire(join(PHOTOS_DIR, "package.json"));
  let entry: string;
  try {
    // The package entry, not `sharp/package.json`: sharp's `exports` map
    // declares only ".", so asking for the manifest subpath throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED even when sharp is installed perfectly —
    // which this function then reported as "sharp is not installed", sending
    // whoever hit it off to run an install that changes nothing.
    entry = require.resolve("sharp");
  } catch {
    console.error(
      `Error: sharp is not installed in ${PHOTOS_DIR}; run \`pnpm install\` before bundling.`,
    );
    process.exit(1);
  }
  // Walk up from the entry file to the package root. sharp's entry lives in
  // lib/, which carries no package.json of its own, so the first one found is
  // the package manifest.
  let pkgDir = dirname(entry);
  while (!existsSync(join(pkgDir, "package.json"))) {
    const parent = dirname(pkgDir);
    if (parent === pkgDir) {
      console.error(`Error: could not locate sharp's package.json from ${entry}.`);
      process.exit(1);
    }
    pkgDir = parent;
  }
  const pkgPath = join(pkgDir, "package.json");
  const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (typeof version !== "string" || version.length === 0) {
    console.error(`Error: could not read a version from ${pkgPath}.`);
    process.exit(1);
  }

  // Guard against a stale tree: sharp carries the libvips CVE surface, and
  // every resize/crop/vision pass runs user-uploaded bytes through it, so
  // bundling something older than package.json asks for is a security
  // regression, not a nuisance.
  const declared = JSON.parse(
    readFileSync(join(PHOTOS_DIR, "package.json"), "utf8"),
  ).dependencies?.sharp;
  const floor = typeof declared === "string" ? rangeFloor(declared) : undefined;
  if (floor) {
    const [a, b] = [versionParts(version), versionParts(floor)];
    const older = a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
    if (older) {
      console.error(
        `Error: photos has sharp ${version} installed but package.json declares ${declared}.\n` +
          `Run \`pnpm install\` to refresh node_modules — bundling now would ship sharp ${version} to the Lambda.`,
      );
      process.exit(1);
    }
  }

  return version;
}

async function buildPhotosBundle(appBasePath: string, distZip: string): Promise<void> {
  const staging = join(tmpdir(), `starkeep-photos-bundle-${Date.now()}`);

  try {
    mkdirSync(staging, { recursive: true });

    // 1. The browser half, built straight into `assets/` — which is where
    //    `src/static-handler.ts` points `createWebAppHandler`. The installer
    //    deploys the Lambda as the only origin, with no S3 asset bucket, so the
    //    shell and every chunk are answered from inside the zip.
    //
    //    `STARKEEP_APP_BASE_PATH` sets Vite's `base`, so every asset URL the
    //    build emits already carries the mount, and it is defined into the
    //    bundle for the URLs no bundler sees — see vite.config.ts.
    //
    //    **Not into `dist/`.** `dist/` is what the local server serves, and a
    //    cloud build left there is an app whose every asset URL is prefixed
    //    `/apps/photos` on a surface that has no such prefix: the shell loads,
    //    the bundle 404s and the page stays blank. That is a failure the local
    //    surface reports long after the command that caused it.
    const assets = join(staging, "assets");
    console.log("\nBuilding photos' browser half with Vite…");
    execSync(`pnpm build --outDir "${assets}" --emptyOutDir`, {
      cwd: PHOTOS_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        STARKEEP_APP_BASE_PATH: appBasePath,
        STARKEEP_FORCE_REMOTE: "true",
        NODE_ENV: "production",
      },
    });
    if (!existsSync(join(assets, "index.html"))) {
      console.error(`Vite produced no shell at ${join(assets, "index.html")}.`);
      process.exit(1);
    }

    // 2. The browser-facing Lambda entry, bundled. The Lambda has no install
    //    step of its own, so `@starkeep/app-client` and Hono are inlined here;
    //    `node:*` stays external because the runtime provides it, and the two
    //    native modules stay external because they must never be reached from
    //    this entry at all — see the size check below, and
    //    `__tests__/worker-bundle-isolation.test.ts`, which is what keeps that
    //    true rather than merely hoped for.
    //
    //    ESM, emitted as `.mjs`: `src/static-handler.ts` awaits the app's
    //    module graph at module scope so the graph loads during Lambda's INIT
    //    phase — elevated CPU, unbilled, its own budget — and top-level await
    //    does not exist in CommonJS. Lambda resolves the manifest's
    //    `index.handler` against `.mjs` as readily as `.js`.
    console.log("\nBundling the static Lambda entry with esbuild…");
    await esbuild({
      entryPoints: [join(PHOTOS_DIR, "src", "static-handler.ts")],
      outfile: join(staging, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["node:*", "sharp", "onnxruntime-node"],
      banner: {
        // The bundle pulls in CJS dependencies that expect `require`.
        js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);",
      },
    });

    const entryBytes = readFileSync(join(staging, "index.mjs")).length;
    if (entryBytes > MAX_STATIC_ENTRY_BYTES) {
      console.error(
        `The static Lambda entry is ${(entryBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
          `${MAX_STATIC_ENTRY_BYTES / 1024 / 1024} MB ceiling. Something in the route graph now ` +
          `reaches a worker engine or a native module; run \`pnpm test ` +
          `worker-bundle-isolation\` for the import chain.`,
      );
      process.exit(1);
    }

    // 3. The resize Lambda, unchanged by this migration. sharp is external —
    //    it needs native binaries installed for the Lambda (linux) platform,
    //    which step 4 does.
    console.log("\nBundling resize-handler with esbuild…");
    const handlersDir = join(staging, "infra", "src");
    mkdirSync(handlersDir, { recursive: true });
    await esbuild({
      entryPoints: [join(INFRA_DIR, "src", "resize-handler.ts")],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outdir: handlersDir,
      external: ["sharp"],
      allowOverwrite: true,
    });

    // 4. Install sharp for the Lambda (linux x64 glibc) platform. --libc=glibc
    //    is required when installing from a non-glibc host (e.g. macOS):
    //    without it npm's libc filter silently drops @img/sharp-linux-x64 and
    //    @img/sharp-libvips-linux-x64, leaving the bundle with sharp's JS but
    //    no native binary, and the Lambda fails at require("sharp") with
    //    "Could not load the sharp module using the linux-x64 runtime".
    //
    //    The version is pinned to whatever the photos workspace resolved — an
    //    unpinned `npm install sharp` here would ship npm's current latest, so
    //    the deployed Lambda would not be reproducible from the repo and could
    //    differ from the sharp the app is developed against. sharp pins its own
    //    @img/sharp-* native packages to exact versions, so pinning sharp pins
    //    the binaries too.
    const sharpVersion = resolveSharpVersion();
    console.log(`\nInstalling sharp@${sharpVersion} for linux/x64 (glibc)…`);
    execSync(
      `npm install --os=linux --cpu=x64 --libc=glibc --no-package-lock --no-save sharp@${sharpVersion}`,
      { cwd: staging, stdio: "inherit" },
    );

    // 5. Zip. `-r`, and no `-y`: the OpenNext output used pnpm's virtual-store
    //    symlinks and had to keep them, but nothing staged here is a symlink
    //    except what npm just installed, and `assets/` has to keep its shape
    //    inside the zip because the adapter resolves paths under it.
    console.log("\nCreating dist.zip…");
    mkdirSync(dirname(distZip), { recursive: true });
    rmSync(distZip, { force: true });
    execSync(`zip -ry "${distZip}" . -q`, { cwd: staging, stdio: "inherit" });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

await buildPhotosBundle(APP_BASE_PATH, BUNDLE_OUT);

const bytes = readFileSync(BUNDLE_OUT).length;
console.log(`\nBundle written: ${BUNDLE_OUT} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
