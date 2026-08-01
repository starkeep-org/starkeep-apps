/**
 * The import loop, against a real folder and a real ledger.
 *
 * The unit tests cover the state machine; this covers the thing that state
 * machine exists for — an import that is interrupted and resumed does not
 * redo work, does not re-fail on files it can never read, and does not
 * silently skip files it should retry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImport, walkImportable } from "../src/photos-lib/import/run-import";
import { openImportStore } from "../src/photos-lib/import/import-store";
import type { ImportStore } from "../src/photos-lib/import/import-store";
import { perceptualDistance } from "../src/photos-lib/image-processing/derive-ladder";
import type { LibraryEntry } from "../src/photos-lib/import/duplicate-tiers";

let dir: string;
let starkeep: string;
let store: ImportStore;
let registered: string[];

function deps(over: Partial<Parameters<typeof runImport>[2]> = {}) {
  return {
    registerFile: async (_b: Uint8Array, name: string) => {
      registered.push(name);
      return { recordId: `rec-${registered.length}`, deduped: false };
    },
    loadLibraryIndex: async (): Promise<LibraryEntry[]> => [],
    perceptualDistance,
    fingerprint: async () => ({ contentHash: "" }),
    ...over,
  } as Parameters<typeof runImport>[2];
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "photos-import-"));
  starkeep = await mkdtemp(join(tmpdir(), "photos-starkeep-"));
  process.env.STARKEEP_DIR = starkeep;
  store = openImportStore(`run-${Math.random().toString(36).slice(2)}`);
  registered = [];
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
  await rm(starkeep, { recursive: true, force: true });
  delete process.env.STARKEEP_DIR;
});

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
}

describe("walking a folder", () => {
  it("finds importable files at any depth", async () => {
    await seed({ "a.jpg": "1", "sub/b.png": "2", "sub/deep/c.heic": "3" });
    const found: string[] = [];
    for await (const p of walkImportable(dir)) found.push(p);
    expect(found).toHaveLength(3);
  });

  it("ignores files that are not images", async () => {
    await seed({ "a.jpg": "1", "notes.txt": "x", "archive.zip": "y", "noext": "z" });
    const found: string[] = [];
    for await (const p of walkImportable(dir)) found.push(p);
    expect(found).toHaveLength(1);
  });

  // `.thumbnails`, `.DS_Store` and every VCS directory are noise, and a real
  // export nests photos nowhere near them.
  it("skips dotfiles and dot-directories", async () => {
    await seed({ ".DS_Store": "x", ".cache/old.jpg": "y", "real.jpg": "z" });
    const found: string[] = [];
    for await (const p of walkImportable(dir)) found.push(p);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("real.jpg");
  });

  it("includes camera raw, which is the whole point of registering those types", async () => {
    await seed({ "shot.dng": "1", "shot.cr3": "2", "shot.nef": "3" });
    const found: string[] = [];
    for await (const p of walkImportable(dir)) found.push(p);
    expect(found).toHaveLength(3);
  });
});

describe("importing", () => {
  it("registers each file once and records the outcome", async () => {
    await seed({ "a.jpg": "one", "b.jpg": "two" });
    const result = await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: null });
    expect(result.processed).toBe(2);
    expect(store.summary().imported).toBe(2);
  });

  // Tier 1 is the server's answer, read off the registration rather than
  // re-implemented here — so it cannot disagree with what the library enforces.
  it("records a server-side dedup as skipped, not imported", async () => {
    await seed({ "a.jpg": "one" });
    await runImport(
      dir,
      store,
      deps({
        registerFile: async () => ({ recordId: "existing", deduped: true }),
      }),
      { delayMs: 0, maxItemsPerRun: null },
    );
    const summary = store.summary();
    expect(summary.skipped).toBe(1);
    expect(summary.imported).toBe(0);
    expect(store.all()[0]!.duplicateTier).toBe("identical");
  });

  // Two files with identical bytes are one object. The second must not produce
  // a second record — and after item 20 the server would collapse it anyway,
  // but the ledger should not claim two imports either.
  it("treats byte-identical files as one item", async () => {
    await seed({ "a.jpg": "same", "copy/a.jpg": "same" });
    await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: null });
    expect(store.all()).toHaveLength(1);
    expect(registered).toHaveLength(1);
  });
});

describe("resuming", () => {
  it("does not re-register anything already imported", async () => {
    await seed({ "a.jpg": "one", "b.jpg": "two" });
    await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: null });
    expect(registered).toHaveLength(2);

    registered = [];
    await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: null });
    expect(registered, "a resume re-did work it had already done").toHaveLength(0);
  });

  // The hash is the identity precisely so this works: an operator who
  // reorganised the folder between runs must not re-import everything.
  it("recognises a file that moved between runs", async () => {
    await seed({ "a.jpg": "content" });
    await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: null });

    await rm(join(dir, "a.jpg"));
    await seed({ "moved/elsewhere.jpg": "content" });
    registered = [];
    await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: null });
    expect(registered).toHaveLength(0);
  });

  it("retries a file that failed transiently", async () => {
    await seed({ "a.jpg": "one" });
    let attempt = 0;
    const flaky = deps({
      registerFile: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network went away");
        return { recordId: "rec-1", deduped: false };
      },
    });
    await runImport(dir, store, flaky, { delayMs: 0, maxItemsPerRun: null });
    expect(store.summary().failed).toBe(1);

    await runImport(dir, store, flaky, { delayMs: 0, maxItemsPerRun: null });
    expect(store.summary().imported).toBe(1);
    expect(store.summary().failed).toBe(0);
  });

  // The distinction that makes a resume useful. Without it, every subsequent
  // run spends itself re-failing on the same unreadable files — which on a
  // large import is indistinguishable from the tool being broken.
  it("never retries a file this build cannot decode", async () => {
    await seed({ "a.heic": "one" });
    let attempts = 0;
    const undecodable = deps({
      registerFile: async () => {
        attempts += 1;
        throw new Error("undecodable-here: no HEIC decoder");
      },
    });
    await runImport(dir, store, undecodable, { delayMs: 0, maxItemsPerRun: null });
    expect(store.summary().unsupported).toBe(1);

    await runImport(dir, store, undecodable, { delayMs: 0, maxItemsPerRun: null });
    expect(attempts, "re-attempted a file it can never read").toBe(1);
  });
});

describe("pacing", () => {
  // An import competes with the derivation it triggers. Running flat out makes
  // the machine unusable and, on a phone, gets the process killed.
  it("stops at the per-run cap and reports that it did", async () => {
    await seed({ "a.jpg": "1", "b.jpg": "2", "c.jpg": "3" });
    const result = await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: 2 });
    expect(result.processed).toBe(2);
    expect(result.stoppedEarly).toBe(true);
  });

  it("finishes the rest on the next run", async () => {
    await seed({ "a.jpg": "1", "b.jpg": "2", "c.jpg": "3" });
    await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: 2 });
    const second = await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: 2 });
    expect(second.stoppedEarly).toBe(false);
    expect(store.summary().imported).toBe(3);
  });
});

describe("advisory findings", () => {
  // Tiers 2 and 3 run *after* the import, never instead of it: the file is
  // already in the library and the finding is a note for a human, not a reason
  // to have withheld somebody's photo.
  it("imports the file and reports the similarity, rather than skipping", async () => {
    await seed({ "a.jpg": "one" });
    const result = await runImport(
      dir,
      store,
      deps({
        loadLibraryIndex: async () => [
          { recordId: "existing", contentHash: "z".repeat(64), perceptualHash: "ffffffffffffffff" },
        ],
        fingerprint: async () => ({
          contentHash: "",
          perceptualHash: "ffffffffffffffff",
        }),
      }),
      { delayMs: 0, maxItemsPerRun: null },
    );
    expect(store.summary().imported).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.tier).toBe("similar");
  });

  // A library with no extracted metadata cannot be compared against, and
  // pretending otherwise would produce findings out of missing data.
  it("reports nothing when the library index is empty", async () => {
    await seed({ "a.jpg": "one" });
    const result = await runImport(dir, store, deps(), { delayMs: 0, maxItemsPerRun: null });
    expect(result.findings).toEqual([]);
  });
});
