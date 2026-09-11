/**
 * Duplicate resolution and import resumption.
 *
 * **This is one of the three places in the plan that can destroy data**, and
 * the destruction here is quiet: a false positive means a photo silently never
 * arrives, and nobody notices until they go looking for it years later. So the
 * adversarial cases below — a burst, a panorama, a screenshot — are the point
 * of the file, not an afterthought.
 *
 * Tier 1 is not covered here and has no cases left to lose: byte-identity is
 * the data server's answer, read off `deduped` at registration, and
 * `import-loop.test.ts` covers the loop reading it. A second implementation
 * over a table that holds no content hash is exactly what this module stopped
 * carrying.
 */
import { describe, it, expect } from "vitest";
import {
  findDuplicate,
  captureFingerprint,
  PERCEPTUAL_DISTANCE_THRESHOLD,
  type ImportCandidate,
  type LibraryEntry,
} from "../src/photos-lib/import/duplicate-tiers";
import { sameCaptureWhere } from "../src/photos-lib/import/library-lookup";
import {
  shouldAttempt,
  summarize,
  isComplete,
  type ImportItem,
} from "../src/photos-lib/import/import-run";
import { perceptualDistance } from "../src/photos-lib/image-processing/derive-ladder";

const HASH_A = "a".repeat(64);

const candidate = (over: Partial<ImportCandidate> = {}): ImportCandidate => ({ ...over });

const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  recordId: "rec-1",
  ...over,
});

const find = (c: ImportCandidate, lib: LibraryEntry[]) =>
  findDuplicate(c, lib, perceptualDistance);

describe("tier 2 — same capture, per the camera", () => {
  const shot = {
    capturedAt: "2026-01-01T12:00:00.000Z",
    cameraMake: "Canon",
    cameraModel: "R5",
    width: 8192,
    height: 5464,
  };

  it("recognises the same exposure arriving twice", () => {
    const result = find(candidate(shot), [entry({ ...shot })]);
    expect(result).toMatchObject({ tier: "same-capture" });
  });

  // The whole reason this tier reports rather than acts. Ten frames shot in one
  // second share a capture second, a camera, and dimensions — and every one is
  // a photo somebody chose to keep.
  //
  // EXIF's `ImageUniqueId` is what separates a burst from a duplicate, and
  // `IMAGE_METADATA_COLUMNS` has no column for it, so no library record can
  // carry one. The tier is stuck at this strength until that registry change
  // lands — which is why it may not act.
  it("only reports, never skips, because a burst looks exactly like this", () => {
    const result = find(candidate(shot), [entry({ ...shot, recordId: "frame-1" })]);
    expect(result).toMatchObject({ tier: "same-capture", action: "report" });
  });

  // Screenshots, exports, and anything through a messaging app have no EXIF.
  // A partial fingerprint would match every one of them against every other.
  it("produces no fingerprint when there is not enough metadata to say anything", () => {
    expect(captureFingerprint(candidate())).toBeNull();
    expect(captureFingerprint(candidate({ capturedAt: "2026-01-01T12:00:00.000Z" }))).toBeNull();
  });

  it("does not match two screenshots against each other", () => {
    const screenshot = candidate({ width: 1170, height: 2532 });
    const other = entry({ width: 1170, height: 2532 });
    expect(find(screenshot, [other])).toBeNull();
  });

  // The fingerprint is also the lookup's predicate, so the two have to agree
  // exactly about when there is a question to ask at all.
  it("asks the library exactly when a fingerprint exists", () => {
    expect(sameCaptureWhere(candidate(shot))).toEqual({
      captured_at: shot.capturedAt,
      camera_make: "Canon",
      camera_model: "R5",
      width: 8192,
      height: 5464,
    });
    expect(sameCaptureWhere(candidate())).toBeNull();
    expect(sameCaptureWhere(candidate({ ...shot, cameraMake: null, cameraModel: null }))).toBeNull();
  });

  // The column is declared `timestamp` and the grammar takes one spelling of
  // it, so a value from anywhere but `toISOString()` has to be refused here —
  // sending it would be a 400 on a route that is only ever asked advisory
  // questions.
  it("declines to ask about a non-canonical capture time", () => {
    expect(sameCaptureWhere(candidate({ ...shot, capturedAt: "2026-01-01T12:00:00Z" }))).toBeNull();
  });

  // A camera that names no make still names a model, and the predicate has to
  // say `IS NULL` for the missing half rather than leaving the column out —
  // omitting it would match every camera instead of the absence of one.
  it("pins a missing make as null rather than dropping the column", () => {
    expect(sameCaptureWhere(candidate({ ...shot, cameraMake: null }))).toMatchObject({
      camera_make: null,
      camera_model: "R5",
    });
  });
});

describe("tier 3 — perceptually similar", () => {
  it("catches a re-encode that shares no bytes and no EXIF", () => {
    // A Storage Saver copy: different bytes, stripped metadata, same picture.
    const result = find(
      candidate({ perceptualHash: "ffffffffffffffff" }),
      // One nibble different — four bits, comfortably inside the threshold.
      // (Two nibbles would be sixteen bits and correctly no match.)
      [entry({ perceptualHash: "fffffffffffffff0" })],
    );
    expect(result).toMatchObject({ tier: "similar", action: "report" });
  });

  it("never skips on resemblance alone", () => {
    const result = find(
      candidate({ perceptualHash: "ffffffffffffffff" }),
      [entry({ perceptualHash: "ffffffffffffffff" })],
    );
    expect(result!.action).toBe("report");
  });

  it("does not match images that merely differ a lot", () => {
    const result = find(
      candidate({ perceptualHash: "0000000000000000" }),
      [entry({ perceptualHash: "ffffffffffffffff" })],
    );
    expect(result).toBeNull();
  });

  it("ignores library entries with no perceptual hash", () => {
    expect(find(candidate({ perceptualHash: "ffffffffffffffff" }), [entry()])).toBeNull();
  });
});

describe("reporting the strongest match only", () => {
  // A file the camera says is the same exposure is not also interestingly
  // "similar" to it; reporting both would bury the one that matters.
  it("prefers same-capture over similarity", () => {
    const shared = {
      capturedAt: "2026-01-01T12:00:00.000Z",
      cameraMake: "Canon",
      cameraModel: "R5",
      width: 8192,
      height: 5464,
      perceptualHash: "ffffffffffffffff",
    };
    const result = find(candidate(shared), [entry({ ...shared, recordId: "rec-x" })]);
    expect(result!.tier).toBe("same-capture");
  });
});

describe("perceptual distance", () => {
  it("is zero for identical hashes and maximal for opposites", () => {
    expect(perceptualDistance("ffffffffffffffff", "ffffffffffffffff")).toBe(0);
    expect(perceptualDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  // One bad stored hash must not abort a whole import scan, and 64 is the safe
  // direction: maximally different never causes a false duplicate.
  it("reports maximum distance for malformed input rather than throwing", () => {
    expect(perceptualDistance("nonsense", "ffffffffffffffff")).toBe(64);
    expect(perceptualDistance("", "")).toBe(64);
  });

  it("uses a threshold low enough that opposites never match", () => {
    expect(PERCEPTUAL_DISTANCE_THRESHOLD).toBeLessThan(64);
  });
});

// ---------------------------------------------------------------------------

const item = (over: Partial<ImportItem> = {}): ImportItem => ({
  contentHash: HASH_A,
  sourcePath: "/photos/a.jpg",
  sizeBytes: 100,
  status: "pending",
  recordId: null,
  duplicateTier: null,
  detail: null,
  updatedAtMs: 0,
  ...over,
});

describe("resuming an interrupted import", () => {
  it("attempts anything never seen before", () => {
    expect(shouldAttempt(null)).toBe(true);
  });

  it("attempts pending and failed items again", () => {
    expect(shouldAttempt(item({ status: "pending" }))).toBe(true);
    expect(shouldAttempt(item({ status: "failed" }))).toBe(true);
  });

  // The distinction that makes a resume useful rather than merely restartable.
  // Conflating these means either abandoning files that would succeed on a
  // second attempt, or spending every subsequent run re-failing on the same
  // unreadable ones — which on a large import is indistinguishable from the
  // tool being broken.
  it("never re-attempts terminal outcomes", () => {
    for (const status of ["imported", "skipped", "unsupported"] as const) {
      expect(shouldAttempt(item({ status })), status).toBe(false);
    }
  });
});

describe("run progress", () => {
  it("counts every outcome", () => {
    const summary = summarize([
      item({ status: "imported" }),
      item({ status: "imported" }),
      item({ status: "skipped" }),
      item({ status: "failed" }),
      item({ status: "unsupported" }),
      item({ status: "pending" }),
    ]);
    expect(summary).toEqual({
      total: 6,
      imported: 2,
      skipped: 1,
      failed: 1,
      unsupported: 1,
      pending: 1,
    });
  });

  // A run whose remaining items are all terminal-but-not-imported is finished.
  // Reporting it as incomplete leaves an operator waiting for progress that
  // will never come.
  it("is complete when nothing is left to retry, even if not everything imported", () => {
    expect(
      isComplete(summarize([item({ status: "imported" }), item({ status: "unsupported" })])),
    ).toBe(true);
  });

  it("is not complete while anything is pending or retryable", () => {
    expect(isComplete(summarize([item({ status: "failed" })]))).toBe(false);
    expect(isComplete(summarize([item({ status: "pending" })]))).toBe(false);
  });
});
