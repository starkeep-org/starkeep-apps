/**
 * What the build emits, checked against what the manifest promises to serve.
 *
 * Gap 8 of the plan's section 3.4: nothing asserted that the shell loads its
 * own chunks. "Renders blank" was guarded only by the empty-`staticAssetPaths`
 * refusal in the bundle script and by core's install-time `post-install-probe`
 * — one of which cannot see the emitted files and the other of which needs a
 * deployed stack.
 *
 * The failure this prevents is specific and was hit twice under the previous
 * framework: the shell arrives, every asset URL in it 404s, and the page stays
 * blank with a clean 200 in the access log. Under Vite it has a new shape — the
 * `base` is a build-time input, so a cloud build left in `dist/` emits URLs
 * prefixed `/apps/photos` on a surface that has no such prefix.
 *
 * This builds the browser half for real, with a cloud base path, and reads the
 * output. It is slower than the rest of the suite and it is the only test that
 * can answer the question.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "/apps/photos";
const OUT = join(tmpdir(), `photos-bundle-output-${process.pid}`);

const manifest = JSON.parse(
  readFileSync(join(PKG_DIR, "starkeep.manifest.json"), "utf8"),
) as {
  infraRequirements: {
    compute: { handlers: { name: string; staticAssetPaths?: string[] }[] };
  };
};
const staticPaths =
  manifest.infraRequirements.compute.handlers.find((h) => h.name === "static")!.staticAssetPaths!;

let shell = "";

beforeAll(async () => {
  const { build } = await import("vite");
  process.env.STARKEEP_APP_BASE_PATH = BASE;
  process.env.STARKEEP_FORCE_REMOTE = "true";
  try {
    await build({
      root: PKG_DIR,
      logLevel: "error",
      build: { outDir: OUT, emptyOutDir: true },
    });
  } finally {
    delete process.env.STARKEEP_APP_BASE_PATH;
    delete process.env.STARKEEP_FORCE_REMOTE;
  }
  shell = readFileSync(join(OUT, "index.html"), "utf8");
}, 120_000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

/** Every same-origin URL the shell asks the browser to load. */
function shellUrls(): string[] {
  return [...shell.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => u.startsWith("/"));
}

describe("the shell the cloud bundle ships", () => {
  it("asks for at least one script, so a blank page is not a passing state", () => {
    expect(shellUrls().length).toBeGreaterThan(0);
  });

  it("carries the mount on every URL it emits", () => {
    // A root-absolute URL without the mount leaves the app entirely and the
    // gateway answers its default 404 — the "signed in but nothing loads"
    // failure, one step earlier.
    for (const url of shellUrls()) {
      expect(url, `${url} does not carry ${BASE}`).toMatch(new RegExp(`^${BASE}/`));
    }
  });

  it("references only files the build actually emitted", () => {
    for (const url of shellUrls()) {
      const file = join(OUT, url.slice(BASE.length));
      expect(existsSync(file), `${url} has no file at ${file}`).toBe(true);
    }
  });

  it("puts every emitted asset under the immutable prefix", () => {
    // `/_immutable/*` is the manifest's only asset declaration and the only
    // path CloudFront caches forever. An asset emitted anywhere else would be
    // undeclared, so the Lambda would refuse it and the page would render
    // blank.
    for (const url of shellUrls()) {
      expect(url, `${url} is outside /_immutable/`).toMatch(
        new RegExp(`^${BASE}/_immutable/`),
      );
    }
  });

  it("references nothing under _next", () => {
    // The framework's prefix. It survives in the platform adapter's defaults
    // for the length of the migration, and Photos must stop reaching for it.
    expect(shell).not.toContain("_next");
  });

  it("has something to answer every path the manifest serves from disk", () => {
    for (const path of staticPaths) {
      if (path.endsWith("/*")) {
        // A glob is satisfied by the build emitting anything under it.
        expect(
          shellUrls().some((u) => u.startsWith(`${BASE}${path.slice(0, -1)}`)),
          `${path} is declared but the build emitted nothing under it`,
        ).toBe(true);
      } else {
        // A literal path is a client route, answered with the shell itself.
        expect(existsSync(join(OUT, "index.html")), `${path} has no shell to answer it`).toBe(true);
      }
    }
  });
});
