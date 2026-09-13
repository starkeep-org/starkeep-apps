/**
 * The artifact that actually ships, driven as the Lambda drives it.
 *
 * Everything else in this suite tests source. This builds `dist.zip` the way
 * `cli-install-app` does, unpacks it, imports the entry the manifest names and
 * calls it with API Gateway v2 events — so it covers the things only the
 * packaged form can be wrong about: whether the staging layout puts the assets
 * where `createWebAppHandler` looks for them, whether the esbuild entry loads at
 * all, whether the mount prefix is stripped before the Hono app routes, and
 * whether the bundle stayed small enough to deploy.
 *
 * That last one is new with the migration and is the reason this test matters
 * more for Photos than it did for Memo. OpenNext traced an import graph and
 * copied what it found; esbuild inlines eagerly, so a single import of the
 * vision engine from a route would pull `onnxruntime-node` — 270 MB unpacked,
 * against Lambda's 250 MB ceiling — into a Lambda that serves HTML.
 * `worker-bundle-isolation.test.ts` is the static guard; this is the one that
 * weighs the result.
 *
 * The entry is imported by a plain `node` child process rather than by this
 * one. Vitest's module runner resolves an import through Vite, which is the
 * opposite of the environment under test: the Lambda runs `node index.mjs` with
 * no transform and nothing installed beside it. The child is also where
 * `STARKEEP_APP_CLIENT_MODE=cloud` belongs — it is what the installer sets on
 * the Lambda, and it is the only mode in which the origin gate does anything,
 * so the answers below are the cloud deployment's own.
 *
 * It is by far the slowest test here — a Vite build, two esbuild passes, an npm
 * install of sharp for linux and a zip — and it is the one that would catch a
 * bundle that installs cleanly and serves a blank page.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PATH = "/apps/photos";

/**
 * What the browser-facing entry may weigh. The same ceiling
 * `infra/build-bundle.ts` refuses to build past, restated here so a change to
 * one is visible against the other.
 */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

interface GatewayResult {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
}

/** An unauthenticated request, the shape API Gateway's payload format 2.0 emits. */
function event(rawPath: string, method = "GET", headers: Record<string, string> = {}) {
  return {
    rawPath,
    rawQueryString: "",
    headers: { "sec-fetch-dest": "empty", ...headers },
    requestContext: { http: { method } },
  };
}

/**
 * Every case the suite makes, run in one child process.
 *
 * One process rather than one per case: the entry's module graph loads during
 * INIT, which is exactly once per container in the real thing too.
 */
const CASES: Record<string, ReturnType<typeof event>> = {
  root: event(BASE_PATH),
  rootSlash: event(`${BASE_PATH}/`),
  signIn: event(`${BASE_PATH}/sign-in`),
  missingAsset: event(`${BASE_PATH}/_immutable/not-a-real-chunk.js`),
  runtimeConfig: event(`${BASE_PATH}/starkeep-runtime-config`),
  sessionProbe: event(`${BASE_PATH}/api/session`),
  dataProxy: event(`${BASE_PATH}/api/local-data/data/records`, "POST"),
  library: event(`${BASE_PATH}/api/photos/library`),
  visionStatus: event(`${BASE_PATH}/api/vision/status`),
  deriveStatus: event(`${BASE_PATH}/api/derive/status`),
  undeclared: event(`${BASE_PATH}/nope`),
  undeclaredNavigation: event(`${BASE_PATH}/nope`, "GET", { "sec-fetch-dest": "document" }),
  // Filled in below: the path is only known once the shell has been built.
  asset: event(BASE_PATH),
};

let work = "";
let unpacked = "";
let results: Record<string, GatewayResult> = {};

const header = (r: GatewayResult, name: string) => r.headers?.[name] ?? "";

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "photos-bundle-test-"));
  const zip = join(work, "dist.zip");
  execFileSync("pnpm", ["bundle"], {
    cwd: PKG_DIR,
    stdio: "pipe",
    env: { ...process.env, STARKEEP_APP_BASE_PATH: BASE_PATH, STARKEEP_BUNDLE_OUT: zip },
  });
  unpacked = join(work, "unpacked");
  execFileSync("unzip", ["-q", zip, "-d", unpacked]);

  const shell = readFileSync(join(unpacked, "assets", "index.html"), "utf8");
  CASES.asset = event(shell.match(/\/apps\/photos\/_immutable\/[^"']+\.js/)![0]);

  const runner = join(unpacked, ".run-cases.mjs");
  writeFileSync(
    runner,
    `const { handler } = await import("./index.mjs");
const cases = JSON.parse(process.argv[2]);
const out = {};
for (const [name, e] of Object.entries(cases)) out[name] = await handler(e, {});
process.stdout.write(JSON.stringify(out));
`,
  );
  const stdout = execFileSync(process.execPath, [runner, JSON.stringify(CASES)], {
    cwd: unpacked,
    encoding: "utf8",
    env: {
      ...process.env,
      STARKEEP_APP_BASE_PATH: BASE_PATH,
      STARKEEP_APP_CLIENT_MODE: "cloud",
    },
  });
  results = JSON.parse(stdout) as Record<string, GatewayResult>;
}, 600_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe("what the zip weighs", () => {
  it("keeps the browser-facing entry small enough to be only an entry", () => {
    // Hono plus `@starkeep/app-client` is under a megabyte. Anything near this
    // ceiling means the route graph reached a worker engine or a native module,
    // which would fail at deploy with an AWS error rather than here with a
    // reason.
    const bytes = statSync(join(unpacked, "index.mjs")).size;
    expect(bytes, `index.mjs is ${(bytes / 1024 / 1024).toFixed(1)} MB`).toBeLessThan(
      MAX_ENTRY_BYTES,
    );
  });

  it("ships sharp for the Lambda's platform, not the build host's", () => {
    // `--libc=glibc` is what keeps npm's filter from dropping the linux
    // binaries when bundling from macOS, which leaves sharp's JS with no native
    // module and fails at `require("sharp")` in the deployed function.
    expect(statSync(join(unpacked, "node_modules", "@img", "sharp-linux-x64")).isDirectory()).toBe(
      true,
    );
  });

  it("does not ship onnxruntime-node", () => {
    // The 270 MB the vision engine exists behind. It belongs in the scan
    // worker's own bundle, which the local surface starts by absolute path and
    // the cloud never starts at all.
    expect(() => statSync(join(unpacked, "node_modules", "onnxruntime-node"))).toThrow();
  });
});

describe("the shell, from disk", () => {
  it("answers both spellings of the app root", () => {
    // API Gateway cannot register a route key with an empty trailing segment, so
    // the bare prefix is the only spelling the platform can make public and a
    // browser will produce the other. Both have to reach the shell.
    for (const name of ["root", "rootSlash"]) {
      expect(results[name]!.statusCode, name).toBe(200);
      expect(header(results[name]!, "content-type"), name).toContain("text/html");
    }
  });

  it("answers the sign-in route with the same shell", () => {
    expect(results.signIn!.statusCode).toBe(200);
    expect(results.signIn!.body).toContain('<div id="root">');
  });

  it("makes the shell revalidate", () => {
    // Its contents change while its name does not, so an immutable answer would
    // pin a browser to the previous deploy's asset names.
    expect(header(results.root!, "cache-control")).toContain("must-revalidate");
  });
});

describe("the staged assets", () => {
  it("serves the shell's own script, cacheable forever", () => {
    expect(results.asset!.statusCode).toBe(200);
    expect(header(results.asset!, "content-type")).toContain("javascript");
    expect(header(results.asset!, "cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("404s a hashed asset the build never emitted", () => {
    // `staticMiss: "notFound"`: the staged directory is the whole truth for this
    // prefix, so a miss is a broken build rather than something the app answers.
    expect(results.missingAsset!.statusCode).toBe(404);
  });
});

describe("the Hono app behind the adapter", () => {
  it("answers the runtime config, which sign-in cannot render without", () => {
    expect(results.runtimeConfig!.statusCode).toBe(200);
    expect(header(results.runtimeConfig!, "content-type")).toContain("application/json");
  });

  it("answers the signed-in probe at the bare session path", () => {
    // The optional catch-all the previous framework spelled `[[...action]]`.
    expect(results.sessionProbe!.statusCode).toBe(200);
    expect(JSON.parse(results.sessionProbe!.body!)).toEqual({ signedIn: false });
  });

  it("keeps the data proxy behind the gate", () => {
    expect(results.dataProxy!.statusCode).toBe(401);
  });

  it("keeps Photos' own data routes behind the gate", () => {
    expect(results.library!.statusCode).toBe(401);
  });

  it("refuses a path nobody declared", () => {
    expect(results.undeclared!.statusCode).toBe(401);
  });

  it("sends a signed-out document navigation to sign-in inside the app", () => {
    // The platform bug Phase 2 found: a gate with no base path sends the
    // browser to `/sign-in` at the distribution root, which belongs to nobody.
    expect(results.undeclaredNavigation!.statusCode).toBe(302);
    expect(header(results.undeclaredNavigation!, "location")).toContain(`${BASE_PATH}/sign-in`);
  });

  it("refuses the on-device routes rather than pretending to run them", () => {
    // Behind the gate here, because the gate runs first and these are not
    // public — which is the right order. The 501 itself is asserted against the
    // app directly in `cloud-vs-local-routes.test.ts`; what this pins is that
    // the packaged form routes them at all rather than 404ing.
    expect([401, 501]).toContain(results.visionStatus!.statusCode);
    expect([401, 501]).toContain(results.deriveStatus!.statusCode);
  });
});
