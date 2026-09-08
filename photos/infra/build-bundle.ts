#!/usr/bin/env tsx
/**
 * Build the Photos Lambda bundle (dist.zip) for cloud install.
 *
 * This is the app-owned half of the install contract. The platform installer
 * (@starkeep/admin-installer cli:install-app) invokes this via `pnpm bundle`
 * in the app's source dir and consumes the resulting dist.zip:
 *
 *   env in:  STARKEEP_APP_BASE_PATH = /apps/<appId>   (platform routing convention)
 *            STARKEEP_BUNDLE_OUT    = <abs path>      (where to write dist.zip)
 *   out:     writes dist.zip to STARKEEP_BUNDLE_OUT
 *
 * Builds the Next.js app with OpenNext, generates the Lambda entry around the
 * platform's web adapter, bundles the resize handler, installs sharp for the
 * Lambda runtime, and zips everything. Knowledge of OpenNext, sharp, and
 * resize-handler lives here in the app — the platform only sees a dist.zip.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const INFRA_DIR = dirname(fileURLToPath(import.meta.url)); // .../photos/infra
const PHOTOS_DIR = resolve(INFRA_DIR, ".."); // .../photos

/**
 * The manifest is the single declaration of which public paths the bundle
 * answers from disk. Reading it here rather than repeating the list in the
 * generated entry is what lets `@starkeep/admin-manifest` check the list
 * against `publicPaths` — a hand-written copy is checkable only by a test that
 * greps this file, which is what the platform schema replaced.
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
  const stagingDir = join(tmpdir(), `starkeep-photos-bundle-${Date.now()}`);

  try {
    mkdirSync(stagingDir, { recursive: true });

    // 1. Build with OpenNext (runs `open-next build` via pnpm build script).
    //    STARKEEP_APP_BASE_PATH bakes Next's basePath into the build so all
    //    asset URLs and routes are emitted under /apps/<appId>, matching how
    //    the shared API Gateway forwards requests.
    console.log("\nBuilding photos app with OpenNext…");
    const buildResult = spawnSync("pnpm", ["build"], {
      cwd: PHOTOS_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        NEXT_PUBLIC_FORCE_REMOTE: "true",
        NODE_ENV: "production",
        STARKEEP_APP_BASE_PATH: appBasePath,
        // basePath isn't exposed to client JS by Next.js; mirror it as a
        // NEXT_PUBLIC_* var so client fetch() calls can prepend it.
        NEXT_PUBLIC_STARKEEP_APP_BASE_PATH: appBasePath,
      },
    });
    if (buildResult.status !== 0) {
      console.error("photos OpenNext build failed.");
      process.exit(buildResult.status ?? 1);
    }

    // 2. Copy the OpenNext server function output to the staging root.
    //    The server function is the Next.js Lambda handler (index.handler).
    const serverFnDir = resolve(PHOTOS_DIR, ".open-next", "server-functions", "default");
    if (!existsSync(serverFnDir)) {
      console.error(`OpenNext server-function dir not found at ${serverFnDir}.`);
      process.exit(1);
    }
    console.log("\nCopying OpenNext server function…");
    // verbatimSymlinks preserves the original relative symlink targets.
    // OpenNext's output relies on pnpm-style relative links (e.g.
    // photos/node_modules/next -> ../../node_modules/.pnpm/...); without this
    // flag Node rewrites them to absolute paths pointing at the local dev
    // machine, which obviously don't resolve inside the Lambda sandbox.
    cpSync(serverFnDir, stagingDir, { recursive: true, verbatimSymlinks: true });

    // 2a. Copy the instrumentation hook's dependency closure, which OpenNext
    //     omits. OpenNext copies every *file* at the root of `.next/server`
    //     (so `instrumentation.js` lands in the bundle) but populates
    //     `.next/server/chunks` only from the `.nft.json` traces of the routes
    //     it knows about, and 3.1.3 has no knowledge of instrumentation at all
    //     — `instrumentation.js.nft.json` is never read. The hook therefore
    //     ships as an entry file whose turbopack chunks are absent.
    //
    //     That is not a degraded background job, it is a dead server. Next
    //     loads the instrumentation module during `prepare()`, before it
    //     serves anything, so the missing chunk throws
    //     "An error occurred while loading the instrumentation hook" and every
    //     request — including the sign-in page — comes back as OpenNext's
    //     `{"message":"Server failed to respond."}` with the real cause only
    //     in CloudWatch.
    //
    //     Paths in the trace are relative to `.next/server` and are resolved
    //     against the real build output rather than `.next/standalone`,
    //     because entries outside `.next` (the derive and scan workers) exist
    //     only in the source tree.
    const PACKAGE_PATH = "photos";
    const stagedServerDir = join(stagingDir, PACKAGE_PATH, ".next", "server");
    const buildServerDir = join(PHOTOS_DIR, ".next", "server");
    const instrumentationTrace = join(buildServerDir, "instrumentation.js.nft.json");
    if (existsSync(join(stagedServerDir, "instrumentation.js"))) {
      if (!existsSync(instrumentationTrace)) {
        console.error(
          `OpenNext staged instrumentation.js but ${instrumentationTrace} does not exist, ` +
            `so its chunks cannot be resolved. The Lambda would fail every request at ` +
            `server startup; refusing to build a bundle that cannot serve.`,
        );
        process.exit(1);
      }
      const traced: string[] = JSON.parse(readFileSync(instrumentationTrace, "utf8")).files ?? [];
      let copied = 0;
      for (const rel of traced) {
        const from = resolve(buildServerDir, rel);
        const to = resolve(stagedServerDir, rel);
        if (!existsSync(from) || existsSync(to)) continue;
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true, verbatimSymlinks: true });
        copied++;
      }
      console.log(`Copied ${copied} instrumentation dependencies OpenNext omitted.`);
    }

    // 2b. Bundle Next.js static assets into the Lambda zip. OpenNext expects
    //     these to live on a CDN/S3 origin (see open-next.output.json
    //     `behaviors`), but this installer ships the server function as the
    //     only origin — so without a local copy every
    //     /apps/photos/_next/static/* request 404s and the page renders blank
    //     (CSR bailout with no chunks). Step 2e is what answers them from here.
    const assetsSrc = resolve(PHOTOS_DIR, ".open-next", "assets");
    if (!existsSync(assetsSrc)) {
      console.error(`OpenNext assets dir not found at ${assetsSrc}.`);
      process.exit(1);
    }
    console.log("Copying OpenNext static assets…");
    cpSync(assetsSrc, join(stagingDir, "assets"), { recursive: true });

    // 2c. Ship the pages the build already rendered.
    //
    //     OpenNext emits prerendered HTML to `.open-next/cache/<BUILD_ID>/` and
    //     expects a deployer to upload it to the bucket its incremental cache
    //     reads. This installer has no such bucket, so without this step the
    //     Lambda has no copy of its own output and re-renders `/` and
    //     `/sign-in` — two static documents — on every request.
    //
    //     The build-id directory is dropped: one bundle ships exactly one
    //     build, so keeping a level named after it only adds a lookup that can
    //     disagree with itself. infra/prerender-cache.ts reads `cache/<key>.cache`.
    const cacheRoot = resolve(PHOTOS_DIR, ".open-next", "cache");
    const buildIdFile = join(PHOTOS_DIR, ".next", "BUILD_ID");
    if (!existsSync(buildIdFile)) {
      console.error(`No ${buildIdFile}; cannot locate the prerender cache.`);
      process.exit(1);
    }
    const buildId = readFileSync(buildIdFile, "utf8").trim();
    const cacheSrc = join(cacheRoot, buildId);
    if (!existsSync(cacheSrc)) {
      console.error(
        `OpenNext prerender cache not found at ${cacheSrc}. Every prerendered ` +
          `page would be re-rendered per request; refusing to build that bundle.`,
      );
      process.exit(1);
    }
    console.log("Copying prerendered pages…");
    cpSync(cacheSrc, join(stagingDir, "cache"), { recursive: true });

    // 2d. Drop build inputs the copy in step 2 swept in. None of it is
    //     reachable at runtime: the tsbuildinfo files are incremental-compile
    //     state, web-assets.json feeds the ASCII banner at build time, and
    //     `out/` is the static export — a second copy of what already went to
    //     `assets/` in 2b. Together they are ~3.3 MB of a 19.5 MB package,
    //     which is download and unpack time on every cold container for bytes
    //     nothing reads.
    for (const dead of [
      join(PACKAGE_PATH, "tsconfig.tsbuildinfo"),
      join(PACKAGE_PATH, "tsconfig.e2e.tsbuildinfo"),
      join(PACKAGE_PATH, "infra", "src", "web-assets.json"),
      join(PACKAGE_PATH, "out"),
    ]) {
      rmSync(join(stagingDir, dead), { recursive: true, force: true });
    }

    // 2e. The browser-facing Lambda entry.
    //
    //     OpenNext expects its static assets on a CDN/S3 origin (see
    //     open-next.output.json `behaviors`), but this installer ships the
    //     server function as the only origin — so something has to answer
    //     /_next/static/* and BUILD_ID from disk before delegating, or every
    //     chunk request 404s and the page renders blank.
    //
    //     That "something" is the platform's, not Photos'. Photos used to
    //     generate its own copy of base-path stripping, MIME mapping, path
    //     containment and cache-control here; Memo and Probe generated theirs.
    //     The copies diverged, and a fix to one never reached the others. What
    //     stays here is the app-shaped configuration: which directory holds the
    //     assets, and which paths the manifest says live in it.
    //
    //     Top-level `await` on the upstream import is the whole point of
    //     `createWebAppHandler` returning a promise: the OpenNext module graph
    //     loads during Lambda's INIT phase, which runs at elevated CPU, is not
    //     billed, and has its own budget — rather than inside a billed,
    //     timeout-bounded first request.
    const staticHandler = manifest.infraRequirements.compute.handlers.find(
      (h) => h.name === "static",
    );
    if (!staticHandler) {
      console.error("photos manifest has no `static` compute handler.");
      process.exit(1);
    }
    // The static branch runs ahead of the origin middleware, so anything it
    // answers is answered without a gate. Taking the list from the manifest
    // rather than hand-writing it here is what makes that checkable: the
    // schema refuses a `staticAssetPaths` entry that `publicPaths` does not
    // already declare public. An empty list is refused here instead of shipped,
    // because a bundle that serves no chunks renders a blank page and reports
    // nothing.
    const staticPaths = staticHandler.staticAssetPaths ?? [];
    if (staticPaths.length === 0) {
      console.error(
        "photos manifest declares no `staticAssetPaths` on the `static` handler, so the " +
          "bundle would answer no /_next/static/* request and every page would render " +
          "blank; refusing to build that bundle.",
      );
      process.exit(1);
    }

    // The OpenNext entry, a sibling file in the zip. The generated entry
    // imports it by this path and esbuild is told to leave it alone, so the
    // specifier survives into the output verbatim and resolves at runtime
    // relative to index.mjs at the staging root.
    const UPSTREAM_ENTRY = `./${PACKAGE_PATH}/index.mjs`;

    const entrySource = `import { createWebAppHandler } from "@starkeep/app-client/web";

export const handler = await createWebAppHandler({
  basePath: ${JSON.stringify(appBasePath)},
  assetsDir: new URL("./assets/", import.meta.url),
  staticPaths: ${JSON.stringify(staticPaths)},
  // A promise, never a thunk — the graph necessarily loads during INIT.
  // Left external below, so it resolves inside the zip at runtime.
  upstream: import(${JSON.stringify(UPSTREAM_ENTRY)}),
});
`;

    // Written inside infra/ rather than the staging dir so esbuild resolves
    // `@starkeep/app-client/web` through the app's own node_modules, then
    // bundled into the zip — the Lambda has no install step of its own.
    console.log("\nBundling the Lambda entry with esbuild…");
    const entrySrcPath = join(INFRA_DIR, ".lambda-entry.mjs");
    writeFileSync(entrySrcPath, entrySource, "utf8");
    try {
      await build({
        entryPoints: [entrySrcPath],
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        outfile: join(stagingDir, "index.mjs"),
        // esbuild emits `import` for these under ESM; Node resolves them
        // natively. The OpenNext entry is external because it is a sibling
        // file in the zip, not a dependency to inline.
        external: ["node:*", UPSTREAM_ENTRY],
      });
    } finally {
      rmSync(entrySrcPath, { force: true });
    }

    // 3. Bundle the backend Lambda handler with esbuild. sharp is external —
    //    it needs native binaries installed for the Lambda (linux) platform.
    console.log("\nBundling resize-handler with esbuild…");
    const handlersDir = join(stagingDir, "infra", "src");
    mkdirSync(handlersDir, { recursive: true });

    await build({
      entryPoints: [
        join(INFRA_DIR, "src", "resize-handler.ts"),
      ],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outdir: handlersDir,
      external: ["sharp"],
      allowOverwrite: true,
    });

    // 4. Install sharp for the Lambda (linux x64 glibc) platform. --libc=glibc
    //    is required when installing from a non-glibc host (e.g. macOS): without
    //    it npm's libc filter silently drops @img/sharp-linux-x64 and
    //    @img/sharp-libvips-linux-x64, leaving the bundle with sharp's JS but
    //    no native binary, and the Lambda fails at require("sharp") with
    //    "Could not load the sharp module using the linux-x64 runtime".
    //
    //    The version is pinned to whatever the photos workspace resolved from
    //    pnpm-lock.yaml — an unpinned `npm install sharp` here would ship npm's
    //    current latest, so the deployed Lambda would not be reproducible from
    //    the repo and could differ from the sharp the app is developed against.
    //    sharp pins its own @img/sharp-* native packages to exact versions, so
    //    pinning sharp pins the binaries too.
    const sharpVersion = resolveSharpVersion();
    console.log(`\nInstalling sharp@${sharpVersion} for linux/x64 (glibc)…`);
    execSync(
      `npm install --os=linux --cpu=x64 --libc=glibc --no-package-lock --no-save sharp@${sharpVersion}`,
      { cwd: stagingDir, stdio: "inherit" },
    );

    // 5. Zip everything in staging dir.
    console.log("\nCreating dist.zip…");
    // -y preserves symlinks: OpenNext's output uses pnpm's virtual-store layout
    // (e.g. photos/node_modules/next -> ../../node_modules/.pnpm/next@.../...),
    // and dereferencing them collapses next into a real copy that can no longer
    // resolve peer deps like @swc/helpers through the .pnpm sibling tree.
    mkdirSync(dirname(distZip), { recursive: true });
    rmSync(distZip, { force: true });
    execSync(`zip -ry "${distZip}" . -q`, { cwd: stagingDir, stdio: "inherit" });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

await buildPhotosBundle(APP_BASE_PATH, BUNDLE_OUT);

const bytes = readFileSync(BUNDLE_OUT).length;
console.log(`\nBundle written: ${BUNDLE_OUT} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
