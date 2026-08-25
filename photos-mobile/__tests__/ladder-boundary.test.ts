/**
 * The platform must not learn what a size class is — and on a phone, nothing
 * but this test enforces it.
 *
 * On the laptop and in the cloud there are two processes with a signed HTTP hop
 * between them, so the boundary holds by construction: the data server has no
 * way to reach the ladder even if someone wanted it to. Here there is one
 * process and one bundle, so the same split is a *module* boundary and a single
 * import would collapse it silently.
 *
 * What that would cost is not theoretical. A class maximum is an app decision
 * whose numbers are explicitly provisional; the moment a platform package reads
 * one, respecifying the ladder stops being a Photos change. And the direction
 * matters more than the fact: a Photos module reading the storage adapter is
 * correct and expected, while a storage adapter reading the ladder is the thing
 * that must never happen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MOBILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(MOBILE_DIR, "src");

/**
 * The one directory that owns Photos' vocabulary on this device.
 *
 * `retention.ts` is the documented second: it names the ladder's rungs because
 * a retention policy is per-size-class and the policy is the app's, which its
 * own header explains at length. Both are *above* the platform, which is the
 * property being asserted.
 */
const PHOTOS_LAYER = [join(SRC, "photos"), join(SRC, "retention.ts")];

/** Packages that must stay ignorant of the ladder. */
const PLATFORM_PACKAGES = [
  "@starkeep/sync-engine",
  "@starkeep/storage-adapter",
  "@starkeep/storage-sqlite",
  "@starkeep/protocol-primitives",
];

const LADDER_PACKAGE = "@starkeep/photos-ladder";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

function importsIn(file: string): string[] {
  const source = readFileSync(file, "utf-8");
  const out: string[] = [];
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

const inPhotosLayer = (file: string) => PHOTOS_LAYER.some((dir) => file.startsWith(dir));
const rel = (file: string) => relative(MOBILE_DIR, file);

describe("which modules may know the ladder", () => {
  const files = walk(SRC);

  it("finds the modules it is meant to be checking", () => {
    // A traversal bug that found nothing would make the assertion below pass
    // vacuously, which is the one failure mode this guard must not have.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map(rel)).toContain(join("src", "photos", "renditions.ts"));
  });

  it.each(files.filter((f) => !inPhotosLayer(f)).map((f) => [rel(f), f]))(
    "%s does not import the ladder",
    (_name, file) => {
      expect(importsIn(file)).not.toContain(LADDER_PACKAGE);
    },
  );

  it("the Photos layer does import it, so the assertion above means something", () => {
    const consumers = walk(join(SRC, "photos")).filter((f) =>
      importsIn(f).includes(LADDER_PACKAGE),
    );
    expect(consumers.length).toBeGreaterThan(0);
  });
});

describe("which way the dependency points", () => {
  it("the ladder package depends on no platform package", () => {
    // The direction is the whole invariant. A Photos module reading the storage
    // adapter is correct; the adapter reading the ladder is not, and a shared
    // package that pulled one in would make the second unavoidable.
    const manifest = JSON.parse(
      readFileSync(
        resolve(MOBILE_DIR, "..", "packages", "photos-ladder", "package.json"),
        "utf-8",
      ),
    ) as { dependencies?: Record<string, string> };
    for (const pkg of PLATFORM_PACKAGES) {
      expect(Object.keys(manifest.dependencies ?? {})).not.toContain(pkg);
    }
  });

  it("the ladder package pulls in nothing at all", () => {
    // Pure arithmetic over sizes, which is what lets it be imported from a
    // Lambda, a Next server and a React Native bundle alike.
    const manifest = JSON.parse(
      readFileSync(
        resolve(MOBILE_DIR, "..", "packages", "photos-ladder", "package.json"),
        "utf-8",
      ),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });
});
