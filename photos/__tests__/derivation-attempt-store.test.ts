/**
 * The node-local ledger of what could not be derived here.
 *
 * The one outcome that matters is `undecodable-here`. Without it persisted, a
 * sweep re-downloads and re-fails on every HEIC in the library on every pass,
 * forever — and a phone-captured library is mostly HEIC. Everything else the
 * ledger records is a nicety by comparison.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allAttempts, clearAttempt, fileAttemptStore } from "@/derivation/attempt-store";
import { attemptsPath, derivationDir } from "@/derivation/paths";
import { recordAttempt } from "@/photos-lib/image-processing/derivation-attempts";

let root: string;
let previousDir: string | undefined;

function resetCache(): void {
  const key = Symbol.for("starkeep.photos.derivation.attempts");
  delete (globalThis as unknown as Record<symbol, unknown>)[key];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-attempts-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
  resetCache();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
  resetCache();
});

describe("where verdicts are kept", () => {
  it("is outside both homes the platform syncs", () => {
    // A verdict is a fact about one machine's codecs. Syncing it would let a
    // phone's failure tell a laptop not to bother with a file the laptop reads
    // fine, which is the exact inversion of what the cross-node fallback is for.
    expect(derivationDir()).toContain(join("app-local", "photos"));
  });
});

describe("recording a verdict", () => {
  it("survives a process restart", async () => {
    const store = fileAttemptStore();
    await store.write(recordAttempt(null, "rec-1", "undecodable-here", Date.now(), "no HEIC here"));
    expect(existsSync(attemptsPath())).toBe(true);

    resetCache();
    expect((await fileAttemptStore().read("rec-1"))?.outcome).toBe("undecodable-here");
  });

  it("keeps the file proportional to the problems, not to the library", async () => {
    const store = fileAttemptStore();
    // A `complete` outcome carries nothing a later pass needs — the rendition
    // query is the authority on what exists — so storing one per record would
    // make this file grow with the library for no reader.
    await store.write(recordAttempt(null, "rec-ok", "complete", Date.now()));
    expect(await store.read("rec-ok")).toBeNull();
    expect(allAttempts().size).toBe(0);
  });

  it("clears a prior failure when the record later succeeds", async () => {
    const store = fileAttemptStore();
    await store.write(recordAttempt(null, "rec-2", "transient-failure", Date.now()));
    expect(await store.read("rec-2")).not.toBeNull();
    await store.write(recordAttempt(null, "rec-2", "complete", Date.now()));
    expect(await store.read("rec-2")).toBeNull();
  });

  it("accumulates consecutive transient failures for backoff", async () => {
    const store = fileAttemptStore();
    let previous = await store.read("rec-3");
    for (let i = 0; i < 3; i++) {
      const next = recordAttempt(previous, "rec-3", "transient-failure", Date.now());
      await store.write(next);
      previous = await store.read("rec-3");
    }
    expect(previous?.consecutiveFailures).toBe(3);
  });
});

describe("forgetting a verdict", () => {
  it("is how a node that gained a decoder retries", async () => {
    // Deliberately manual. Detecting a newly installed codec automatically
    // would be a lot of machinery guarding a once-a-year event; deleting a file
    // is the supported answer.
    const store = fileAttemptStore();
    await store.write(recordAttempt(null, "rec-4", "undecodable-here", Date.now()));
    clearAttempt("rec-4");
    expect(await store.read("rec-4")).toBeNull();
  });
});
