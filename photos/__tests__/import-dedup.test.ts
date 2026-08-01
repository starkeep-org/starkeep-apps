/**
 * Duplicate resolution and import resumption.
 *
 * **This is one of the three places in the plan that can destroy data**, and
 * the destruction here is quiet: a false positive means a photo silently never
 * arrives, and nobody notices until they go looking for it years later. So the
 * adversarial cases below — a burst, a panorama, a screenshot — are the point
 * of the file, not an afterthought.
 */
import { describe, it, expect } from "vitest";
import {
  findDuplicate,
  captureFingerprint,
  PERCEPTUAL_DISTANCE_THRESHOLD,
  type ImportCandidate,
  type LibraryEntry,
} from "../src/photos-lib/import/duplicate-tiers";
import {
  shouldAttempt,
  summarize,
  isComplete,
  type ImportItem,
} from "../src/photos-lib/import/import-run";
import { perceptualDistance } from "../src/photos-lib/image-processing/derive-ladder";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const candidate = (over: Partial<ImportCandidate> = {}): ImportCandidate => ({
  contentHash: HASH_A,
  ...over,
});

const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  recordId: "rec-1",
  contentHash: HASH_B,
  ...over,
});

const find = (c: ImportCandidate, lib: LibraryEntry[]) =>
  findDuplicate(c, lib, perceptualDistance);

describe("tier 1 — byte-identical", () => {
  // The only tier that acts, and the only one with no threshold to get wrong.
  it("skips a file whose bytes are already in the library", () => {
    const result = find(candidate(), [entry({ contentHash: HASH_A })]);
    expect(result).toMatchObject({ tier: "identical", action: "skip" });
  });

  it("does not match a different file", () => {
    expect(find(candidate(), [entry()])).toBeNull();
  });
});

describe("tier 2 — same capture, per the camera", () => {
  const shot = {
    capturedAt: "2026-01-01T12:00:00Z",
    imageUniqueId: "UID-1",
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
  it("only reports, never skips, because a burst looks exactly like this", () => {
    const burstFrame = { ...shot, imageUniqueId: null };
    const result = find(candidate(burstFrame), [entry({ ...burstFrame, recordId: "frame-1" })]);
    expect(result).toMatchObject({ tier: "same-capture", action: "report" });
    expect(result!.action).not.toBe("skip");
  });

  // Screenshots, exports, and anything through a messaging app have no EXIF.
  // A partial fingerprint would match every one of them against every other.
  it("produces no fingerprint when there is not enough metadata to say anything", () => {
    expect(captureFingerprint(candidate())).toBeNull();
    expect(captureFingerprint(candidate({ capturedAt: "2026-01-01T12:00:00Z" }))).toBeNull();
  });

  it("does not match two screenshots against each other", () => {
    const screenshot = candidate({ width: 1170, height: 2532 });
    const other = entry({ contentHash: HASH_B, width: 1170, height: 2532 });
    expect(find(screenshot, [other])).toBeNull();
  });

  // A camera-written UID is the strong form; make/model + dimensions is the
  // fallback, and the difference is why one is trustworthy and the other is not.
  it("prefers a unique id over make/model when the camera writes one", () => {
    const withUid = captureFingerprint(candidate(shot))!;
    const withoutUid = captureFingerprint(candidate({ ...shot, imageUniqueId: null }))!;
    expect(withUid).not.toBe(withoutUid);
    expect(withUid).toContain("uid:");
    expect(withoutUid).toContain("cam:");
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
  // A file byte-identical to something is not also interestingly "similar" to
  // it; reporting both would bury the one that matters.
  it("prefers identical over the weaker tiers", () => {
    const shared = {
      contentHash: HASH_A,
      capturedAt: "2026-01-01T12:00:00Z",
      imageUniqueId: "UID-1",
      perceptualHash: "ffffffffffffffff",
    };
    const result = find(candidate(shared), [entry({ ...shared, recordId: "rec-x" })]);
    expect(result!.tier).toBe("identical");
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
