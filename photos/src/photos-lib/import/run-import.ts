/**
 * The import loop: walk a folder, and turn each file into a record or a
 * recorded reason why not.
 *
 * ## Tier 1 is the server's job, not this loop's
 *
 * Registration already collapses a byte-identical record server-side, using an
 * index built for exactly that lookup. So this loop does not scan the library
 * for content-hash matches — it registers and reads `deduped` off the answer.
 * That turns what would be O(library) per file into one indexed lookup per
 * file, and makes the authoritative check the one the library actually
 * enforces rather than a second implementation that can disagree with it.
 *
 * Tiers 2 and 3 need a comparison the server has no index for, so their
 * candidate set is fetched **once per run** rather than once per file. On a
 * 60k-item library that is one page-through at the start instead of 60k
 * scans — still linear in library size, but paid once.
 *
 * ## Every file ends in a recorded state
 *
 * A file that throws is `failed` (retried next run); one this build cannot
 * decode is `unsupported` (terminal). The distinction is the whole reason a
 * resume is useful, and it is decided here rather than inferred later from an
 * error string.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ImportItem, ImportPacing } from "./import-run";
import { DEFAULT_PACING, shouldAttempt } from "./import-run";
import type { ImportStore } from "./import-store";
import { findDuplicate, type DuplicateFinding, type LibraryEntry } from "./duplicate-tiers";

/** Still extensions worth opening. */
const IMPORTABLE_STILLS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".avif",
  ".bmp", ".tif", ".tiff", ".dng", ".cr2", ".cr3", ".nef", ".arw",
  ".raf", ".orf", ".rw2",
]);

/**
 * Video extensions, matching the `video/*` types the manifest grants.
 *
 * A camera roll is photos and clips together, and an import that silently
 * walked past every `.mov` would leave half of it behind without saying so.
 */
const IMPORTABLE_VIDEO = new Set([
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".mpg", ".mpeg", ".wmv", ".flv",
]);

const IMPORTABLE = new Set([...IMPORTABLE_STILLS, ...IMPORTABLE_VIDEO]);

/** Whether a path is video, by extension — the only signal available pre-open. */
export function isVideoPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMPORTABLE_VIDEO.has(path.slice(dot).toLowerCase());
}

export interface ImportDeps {
  /**
   * Register one file and return the resulting record.
   *
   * Takes a **path**, not bytes. Video made that mandatory: this loop used to
   * read each file whole to hash it and hand the buffer on, which is
   * unremarkable for a 3 MB still and an outright OOM for a 4 GB clip. The
   * hash is now computed by streaming, and the uploader reads from disk on its
   * own terms — so no whole file is ever resident here.
   *
   * `deduped` is the server's answer to tier 1 — authoritative, because it is
   * the same check the library enforces on every write.
   */
  readonly registerFile: (
    path: string,
    fileName: string,
    contentHash: string,
    sizeBytes: number,
  ) => Promise<{ recordId: string; deduped: boolean }>;
  /**
   * The library's fingerprints, fetched once per run for tiers 2 and 3.
   *
   * Empty is a valid answer and simply means those tiers report nothing — a
   * library with no extracted metadata cannot be compared against, and
   * pretending otherwise would produce findings from missing data.
   */
  readonly loadLibraryIndex: () => Promise<LibraryEntry[]>;
  readonly perceptualDistance: (a: string, b: string) => number;
  /**
   * Fingerprints for one candidate file, for tiers 2 and 3.
   *
   * Only called for stills. A perceptual hash of a video is not defined here,
   * and decoding a clip to invent one would cost the most expensive operation
   * in the loop to produce a number nothing compares against.
   */
  readonly fingerprint: (
    path: string,
    contentHash: string,
  ) => Promise<Omit<LibraryEntry, "recordId">>;
  /** Called after a successful registration so the ladder gets derived. */
  readonly onImported?: (recordId: string, path: string) => Promise<void>;
}

export interface ImportProgress {
  readonly processed: number;
  readonly findings: readonly (DuplicateFinding & { sourcePath: string })[];
  /** True when the run stopped because it hit `maxItemsPerRun`, not because it finished. */
  readonly stoppedEarly: boolean;
}

/** Every importable file under `root`, depth-first. */
export async function* walkImportable(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // An unreadable directory is skipped rather than aborting the walk: one
    // permission-denied folder must not cost the whole import.
    return;
  }
  for (const entry of entries) {
    // Skip dotfiles: `.thumbnails`, `.DS_Store` and every VCS directory are
    // noise, and a Takeout export nests real photos nowhere near them.
    if (entry.name.startsWith(".")) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkImportable(full);
      continue;
    }
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    if (IMPORTABLE.has(entry.name.slice(dot).toLowerCase())) yield full;
  }
}

export async function runImport(
  root: string,
  store: ImportStore,
  deps: ImportDeps,
  pacing: ImportPacing = DEFAULT_PACING,
): Promise<ImportProgress> {
  // Once per run, not once per file — see the note at the top.
  const library = await deps.loadLibraryIndex();
  const findings: (DuplicateFinding & { sourcePath: string })[] = [];
  let processed = 0;
  let stoppedEarly = false;

  for await (const path of walkImportable(root)) {
    if (pacing.maxItemsPerRun !== null && processed >= pacing.maxItemsPerRun) {
      stoppedEarly = true;
      break;
    }

    let sizeBytes: number;
    let contentHash: string;
    try {
      sizeBytes = (await stat(path)).size;
      contentHash = await hashFile(path);
    } catch (err) {
      // Unreadable *right now* — locked, or on a volume that went away. Worth
      // trying again, so it is not recorded as unsupported.
      recordFailure(store, path, 0, `unreadable: ${(err as Error).message}`);
      processed += 1;
      continue;
    }

    // Hashing happens before this check because the hash *is* the identity —
    // a file that moved between runs must be recognised, and its path cannot
    // do that.
    const previous = store.get(contentHash);
    if (!shouldAttempt(previous)) continue;

    try {
      const { recordId, deduped } = await deps.registerFile(
        path,
        path.slice(path.lastIndexOf("/") + 1),
        contentHash,
        sizeBytes,
      );

      if (deduped) {
        // Tier 1, decided by the server against its own index.
        store.put(
          item(contentHash, path, sizeBytes, "skipped", {
            recordId,
            duplicateTier: "identical",
            detail: "byte-identical to an existing record",
          }),
        );
        processed += 1;
        await pause(pacing.delayMs);
        continue;
      }

      // Tiers 2 and 3 are advisory. They run *after* the import, not instead of
      // it: the file is already in the library, and the finding is a note for a
      // human to review — never a reason to have withheld it.
      // Stills only: a perceptual hash of a video is not defined here, and
      // decoding a clip to invent one would be the most expensive operation in
      // the loop, producing a number nothing compares against.
      if (library.length > 0 && !isVideoPath(path)) {
        // Spread first, then pin the hash: the fingerprint provider has no
        // business overriding the identity of the file it was handed.
        const candidate = { ...(await deps.fingerprint(path, contentHash)), contentHash };
        const finding = findDuplicate(candidate, library, deps.perceptualDistance);
        if (finding && finding.action === "report") {
          findings.push({ ...finding, sourcePath: path });
        }
      }

      store.put(item(contentHash, path, sizeBytes, "imported", { recordId }));
      await deps.onImported?.(recordId, path);
    } catch (err) {
      const message = (err as Error).message;
      // A decode failure is terminal for this build; anything else might not
      // recur. Deciding here rather than inferring from an error string later
      // is what keeps `unsupported` meaning something.
      const terminal = /unsupported|undecodable|unsupported image format/i.test(message);
      store.put(
        item(contentHash, path, sizeBytes, terminal ? "unsupported" : "failed", {
          detail: message,
        }),
      );
    }

    processed += 1;
    // Pacing matters more than it looks: an import competes with the derivation
    // it triggers, and running flat out makes the machine unusable.
    await pause(pacing.delayMs);
  }

  return { processed, findings, stoppedEarly };
}

function item(
  contentHash: string,
  sourcePath: string,
  sizeBytes: number,
  status: ImportItem["status"],
  extra: Partial<ImportItem> = {},
): ImportItem {
  return {
    contentHash,
    sourcePath,
    sizeBytes,
    status,
    recordId: null,
    duplicateTier: null,
    detail: null,
    updatedAtMs: Date.now(),
    ...extra,
  };
}

function recordFailure(
  store: ImportStore,
  path: string,
  sizeBytes: number,
  detail: string,
): void {
  // Keyed by path rather than hash, because the hash is precisely what could
  // not be computed. Collides with nothing: a real hash is 64 hex characters.
  store.put(item(`path:${path}`, path, sizeBytes, "failed", { detail }));
}

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Content hash, computed by streaming.
 *
 * Deliberately not `readFile` then hash. The hash *is* the identity, so it has
 * to be computed before anything else can happen — which means a buffered read
 * would put every file in memory whole, including the 4 GB clip. Reading a file
 * to hash it stays cheap next to decoding and deriving from it, so the ordering
 * is right; it just must not be resident.
 */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
