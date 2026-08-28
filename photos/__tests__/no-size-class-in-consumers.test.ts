/**
 * No consumer may name a size class.
 *
 * This is a grep, and it is worth more than any single behavioural test in this
 * area — because the failure it prevents is "a client hard-codes
 * `image-screen`" and that is **invisible until a respec**. Everything looks
 * fine, renders fine, and passes its own tests, right up until the class
 * maxima move and every device that updates on its own schedule is asking for
 * a rung that no longer means what it meant.
 *
 * The ladder's numbers are the output of a visual test that has not run yet, so
 * this is not hypothetical: the class names in use today are *expected* to be
 * respecified.
 *
 * ## The contract
 *
 * Consumers ask for a **target long edge in pixels**. The server resolves which
 * rendition answers it. A consumer may read the dimensions it got back; it may
 * not name, compute, or branch on a class.
 *
 * ## Where classes legitimately appear
 *
 * The ladder definition (which *is* the vocabulary), derivation (which produces
 * the rungs), publication (which labels them), and their tests. Those are the
 * places that reason about classes on purpose. Everything else — UI, data
 * fetching, viewer, grid — must not.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { STILL_LADDER, VIDEO_LADDER } from "../src/photos-lib/ladder";

const ROOT = join(__dirname, "..");

/**
 * Files allowed to name a size class, and why.
 *
 * Deliberately a small explicit list rather than a pattern: adding to it should
 * take a deliberate act and a reason, because every addition is a place that
 * has to change when the ladder is respecified.
 */
const ALLOWED = [
  // The vocabulary itself.
  join("src", "photos-lib", "ladder.ts"),
  // Produces the rungs, and decides which are missing.
  join("src", "photos-lib", "image-processing", "derive-ladder.ts"),
  // Labels them on publication.
  join("src", "photos-lib", "image-processing", "publish-renditions.ts"),
  // Discovers missing rungs for both still and video sweep stages.
  join("src", "derivation", "sweep-set.ts"),
  // Names the medium stage's producer target; browser consumers still use pixels.
  join("src", "derivation", "engine", "derive-worker.ts"),
  // Names the rung the resize path checks a record against before deriving.
  join("src", "photos-lib", "labels.ts"),
];

const SEARCH_DIRS = ["src", "app", "infra"];
const EXTENSIONS = [".ts", ".tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const ALL_CLASS_NAMES = [
  ...STILL_LADDER.map((s) => s.sizeClass),
  ...VIDEO_LADDER.map((v) => v.sizeClass),
];

describe("size-class names stay out of consumers", () => {
  it("has class names to check for", () => {
    // Guards the guard: if the ladder were ever empty this test would pass
    // vacuously and quietly stop protecting anything.
    expect(ALL_CLASS_NAMES.length).toBeGreaterThan(5);
  });

  it("finds no size-class literal outside the ladder and its producers", () => {
    const offenders: string[] = [];

    for (const searchDir of SEARCH_DIRS) {
      const abs = join(ROOT, searchDir);
      let files: string[];
      try {
        files = walk(abs);
      } catch {
        continue; // directory absent in some builds
      }
      for (const file of files) {
        const rel = relative(ROOT, file);
        if (ALLOWED.some((a) => rel === a || rel.split(sep).join(sep) === a)) continue;
        const source = readFileSync(file, "utf8");
        for (const className of ALL_CLASS_NAMES) {
          // Quoted only: a comment explaining the ladder is fine, a string
          // literal fed to a request is not.
          if (source.includes(`"${className}"`) || source.includes(`'${className}'`)) {
            offenders.push(`${rel} names "${className}"`);
          }
        }
      }
    }

    expect(
      offenders,
      "A consumer naming a size class breaks silently when the ladder is " +
        "respecified. Ask for a target long edge in pixels instead, and let " +
        "the server resolve which rendition answers it. If this file genuinely " +
        "produces or labels renditions, add it to ALLOWED with a reason.",
    ).toEqual([]);
  });

  it("keeps the allowlist small enough to review", () => {
    // Not a style preference. Every entry is a place that must be revisited on
    // a respec, so the list growing quietly is the thing to notice.
    expect(ALLOWED.length).toBeLessThanOrEqual(6);
  });
});
