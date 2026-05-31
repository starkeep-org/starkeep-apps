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
 * Builds the Next.js app with OpenNext, bundles the resize handler, installs
 * sharp for the Lambda runtime, and zips everything. Knowledge of OpenNext,
 * the static-asset wrapper, sharp, and resize-handler lives here in the app —
 * the platform only sees a dist.zip.
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
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const INFRA_DIR = dirname(fileURLToPath(import.meta.url)); // .../photos/infra
const PHOTOS_DIR = resolve(INFRA_DIR, ".."); // .../photos
// The app's pnpm workspace anchor (the app's parent dir, e.g. starkeep-apps),
// which reaches into core's packages so @starkeep/* deps resolve and build.
const WORKSPACE_ROOT = resolve(PHOTOS_DIR, ".."); // .../starkeep-apps

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

async function buildPhotosBundle(appBasePath: string, distZip: string): Promise<void> {
  const stagingDir = join(tmpdir(), `starkeep-photos-bundle-${Date.now()}`);

  try {
    mkdirSync(stagingDir, { recursive: true });

    // 1. Build the @starkeep/* workspace packages the app depends on, from the
    //    app's workspace root (which reaches into core's packages). Their dist/
    //    output must exist before OpenNext/esbuild bundle the app.
    const WS_PACKAGES = [
      "@starkeep/core",
      "@starkeep/storage-adapter",
      "@starkeep/storage-s3",
      "@starkeep/storage-aurora-dsql",
    ];
    console.log("\nBuilding workspace packages…");
    for (const pkg of WS_PACKAGES) {
      console.log(`  pnpm build: ${pkg}`);
      execSync(`pnpm --filter "${pkg}" build`, { cwd: WORKSPACE_ROOT, stdio: "inherit" });
    }

    // 2. Build with OpenNext (runs `open-next build` via pnpm build script).
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

    // 3. Copy the OpenNext server function output to the staging root.
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

    // 3b. Bundle Next.js static assets into the Lambda zip and overwrite
    //     the OpenNext entry with a wrapper that serves /_next/* and
    //     BUILD_ID from local disk before delegating to OpenNext. OpenNext
    //     normally expects these to live on a CDN/S3 origin (see
    //     open-next.output.json `behaviors`), but this installer ships the
    //     server function as the only origin — so without this wrapper every
    //     /apps/photos/_next/static/* request 404s and the page renders
    //     blank (CSR bailout with no chunks).
    const assetsSrc = resolve(PHOTOS_DIR, ".open-next", "assets");
    if (!existsSync(assetsSrc)) {
      console.error(`OpenNext assets dir not found at ${assetsSrc}.`);
      process.exit(1);
    }
    console.log("Copying OpenNext static assets…");
    cpSync(assetsSrc, join(stagingDir, "assets"), { recursive: true });

    const wrapper = `import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "assets");
const BASE_PATH = ${JSON.stringify(appBasePath)};

const MIME = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

const TEXT_EXT = new Set([".js", ".mjs", ".css", ".json", ".map", ".svg", ".txt", ".html"]);

function contentTypeFor(path) {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function isStaticAssetPath(rest) {
  // Only _next/static/* and BUILD_ID live on disk in .open-next/assets.
  // _next/data/* and _next/image* are handled by the OpenNext server.
  return rest === "BUILD_ID" || rest.startsWith("_next/static/");
}

let upstreamHandler;
async function getUpstream() {
  if (!upstreamHandler) {
    const mod = await import("./photos/index.mjs");
    upstreamHandler = mod.handler;
  }
  return upstreamHandler;
}

export async function handler(event, context) {
  const rawPath = event?.rawPath ?? "";
  if (rawPath.startsWith(BASE_PATH + "/")) {
    const rest = rawPath.slice(BASE_PATH.length + 1);
    if (isStaticAssetPath(rest)) {
      // normalize() collapses any "../" segments before we touch the FS;
      // we then explicitly reject anything that still escapes ASSETS_DIR.
      const safeRest = normalize(rest);
      const filePath = join(ASSETS_DIR, safeRest);
      if (!filePath.startsWith(ASSETS_DIR + "/") && filePath !== ASSETS_DIR) {
        return { statusCode: 400, headers: { "content-type": "text/plain" }, body: "Bad path" };
      }
      try {
        const s = await stat(filePath);
        if (s.isFile()) {
          const ct = contentTypeFor(filePath);
          const ext = filePath.slice(filePath.lastIndexOf("."));
          const isImmutable = rest.startsWith("_next/static/");
          const cacheControl = isImmutable
            ? "public, max-age=31536000, immutable"
            : "public, max-age=0, must-revalidate";
          if (TEXT_EXT.has(ext.toLowerCase())) {
            const body = await readFile(filePath, "utf8");
            return {
              statusCode: 200,
              headers: { "content-type": ct, "cache-control": cacheControl },
              body,
            };
          }
          const buf = await readFile(filePath);
          return {
            statusCode: 200,
            headers: { "content-type": ct, "cache-control": cacheControl },
            body: buf.toString("base64"),
            isBase64Encoded: true,
          };
        }
      } catch (e) {
        if (e?.code !== "ENOENT") {
          console.error("Static asset read error:", e);
        }
        // fall through to upstream on miss
      }
    }
  }
  const up = await getUpstream();
  return up(event, context);
}
`;
    writeFileSync(join(stagingDir, "index.mjs"), wrapper, "utf8");

    // 4. Bundle the backend Lambda handler with esbuild. sharp is external —
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

    // 5. Install sharp for the Lambda (linux x64 glibc) platform. --libc=glibc
    //    is required when installing from a non-glibc host (e.g. macOS): without
    //    it npm's libc filter silently drops @img/sharp-linux-x64 and
    //    @img/sharp-libvips-linux-x64, leaving the bundle with sharp's JS but
    //    no native binary, and the Lambda fails at require("sharp") with
    //    "Could not load the sharp module using the linux-x64 runtime".
    console.log("\nInstalling sharp for linux/x64 (glibc)…");
    execSync(
      "npm install --os=linux --cpu=x64 --libc=glibc --no-package-lock --no-save sharp",
      { cwd: stagingDir, stdio: "inherit" },
    );

    // 6. Zip everything in staging dir.
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
