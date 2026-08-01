/**
 * Three-tier duplicate resolution for imports.
 *
 * ## Skip and log, never delete
 *
 * Nothing in this file removes anything. A duplicate is something *not
 * imported*, which leaves the library exactly as it was — the reversible
 * outcome. Deleting an existing record on a match would make a false positive
 * permanent, and a false positive here is somebody's photo.
 *
 * ## Tiers 2 and 3 ship report-only
 *
 * Only tier 1 acts. The other two produce findings for a human, because their
 * thresholds are **unvalidated in the false-positive direction** and the things
 * that decide those thresholds — bursts, panoramas, screenshots, Storage Saver
 * re-encodes — are precisely what a real photo library is full of.
 *
 * A burst of ten frames shot in one second shares a capture second, a camera
 * model, and dimensions, and looks near-identical to a perceptual hash. Every
 * one of those frames is a photo the user chose to keep. Calibrating against a
 * real export is the prerequisite for letting tiers 2 and 3 act, and until then
 * "report-only" is not timidity — it is the difference between a useful tool
 * and one that silently eats a burst.
 */

/** How confident a match is, and therefore what may be done about it. */
export type DuplicateTier =
  /**
   * Byte-identical: the content hashes match. The same file, definitionally —
   * there is no interpretation involved and no threshold to get wrong.
   */
  | "identical"
  /**
   * The camera says these are the same exposure: same capture timestamp and
   * same image UID, or failing a UID, same make/model and native dimensions.
   *
   * Strong but not conclusive. Two frames of a burst share everything here
   * except the UID, and not every camera writes one.
   */
  | "same-capture"
  /**
   * The images look alike to a perceptual hash.
   *
   * The weakest tier and the one that catches re-encodes — a Storage Saver copy
   * of a photo you already have is not byte-identical and carries no EXIF, so
   * nothing above finds it. It also catches things that merely resemble each
   * other, which is why it never acts on its own.
   */
  | "similar";

export interface ImportCandidate {
  readonly contentHash: string;
  readonly capturedAt?: string | null;
  readonly imageUniqueId?: string | null;
  readonly cameraMake?: string | null;
  readonly cameraModel?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly perceptualHash?: string | null;
}

export interface LibraryEntry extends ImportCandidate {
  readonly recordId: string;
  readonly originalFilename?: string | null;
}

export interface DuplicateFinding {
  readonly tier: DuplicateTier;
  readonly existingRecordId: string;
  /** Human-readable reason, for the import report. Never parsed. */
  readonly reason: string;
  /** Only `identical` acts; the rest are reported for a person to judge. */
  readonly action: "skip" | "report";
}

/**
 * How many bits two perceptual hashes may differ by and still be called similar.
 *
 * A guess, and labelled as one. Too low and a re-encode is missed; too high and
 * two photos of the same scene collapse into one. It is only ever used to
 * *report*, so being wrong costs a line in a report rather than a photo.
 */
export const PERCEPTUAL_DISTANCE_THRESHOLD = 6;

/**
 * The capture fingerprint two images must share to be called the same
 * exposure.
 *
 * `null` when there is not enough metadata to say anything — which is the
 * common case for screenshots, exports, and anything that has been through a
 * messaging app. Returning null rather than a partial fingerprint is what stops
 * "two files with no EXIF" reading as "the same photo", which would match
 * essentially every screenshot in a library against every other.
 */
export function captureFingerprint(candidate: ImportCandidate): string | null {
  if (!candidate.capturedAt) return null;
  if (candidate.imageUniqueId) {
    return `uid:${candidate.capturedAt}:${candidate.imageUniqueId}`;
  }
  // No UID — fall back to make/model plus native dimensions. Weaker, and the
  // reason this tier reports rather than acts: a burst shares all of it.
  if (!candidate.cameraMake && !candidate.cameraModel) return null;
  if (!candidate.width || !candidate.height) return null;
  return `cam:${candidate.capturedAt}:${candidate.cameraMake ?? ""}:${candidate.cameraModel ?? ""}:${candidate.width}x${candidate.height}`;
}

/**
 * Compare one incoming file against the library.
 *
 * Returns the **strongest** finding only. A file that is byte-identical to
 * something is not also interestingly "similar" to it, and reporting both would
 * bury the one that matters.
 */
export function findDuplicate(
  candidate: ImportCandidate,
  library: readonly LibraryEntry[],
  perceptualDistance: (a: string, b: string) => number,
): DuplicateFinding | null {
  // Tier 1 — byte-identical. The only tier that acts.
  for (const entry of library) {
    if (entry.contentHash === candidate.contentHash) {
      return {
        tier: "identical",
        existingRecordId: entry.recordId,
        reason: "byte-identical to an existing record",
        action: "skip",
      };
    }
  }

  // Tier 2 — same capture, per the camera.
  const fingerprint = captureFingerprint(candidate);
  if (fingerprint) {
    for (const entry of library) {
      if (captureFingerprint(entry) === fingerprint) {
        return {
          tier: "same-capture",
          existingRecordId: entry.recordId,
          reason: `same capture fingerprint as ${entry.originalFilename ?? entry.recordId}`,
          // Reported, not skipped. A burst shares this fingerprint, and every
          // frame of it is a photo somebody chose to keep.
          action: "report",
        };
      }
    }
  }

  // Tier 3 — perceptually similar.
  if (candidate.perceptualHash) {
    for (const entry of library) {
      if (!entry.perceptualHash) continue;
      const distance = perceptualDistance(candidate.perceptualHash, entry.perceptualHash);
      if (distance <= PERCEPTUAL_DISTANCE_THRESHOLD) {
        return {
          tier: "similar",
          existingRecordId: entry.recordId,
          reason: `perceptually similar (distance ${distance}) to ${entry.originalFilename ?? entry.recordId}`,
          action: "report",
        };
      }
    }
  }

  return null;
}
