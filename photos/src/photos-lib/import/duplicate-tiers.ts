/**
 * Duplicate resolution for imports: the tiers, and what each may do about a
 * match.
 *
 * ## Skip and log, never delete
 *
 * Nothing in this file removes anything. A duplicate is something *not
 * imported*, which leaves the library exactly as it was — the reversible
 * outcome. Deleting an existing record on a match would make a false positive
 * permanent, and a false positive here is somebody's photo.
 *
 * ## Tier 1 is not in this file
 *
 * Byte-identity is decided by the data server, on the index it already keeps
 * for exactly that lookup: registration collapses a byte-identical record and
 * answers `deduped`. `run-import.ts` reads that answer. This file holds the two
 * tiers that compare *facts about the picture* rather than about the bytes, and
 * it compares them against the handful of records a per-candidate metadata
 * lookup returned — never against the library, which it is not handed and could
 * not afford to be.
 *
 * That split is also why `LibraryEntry` carries no content hash. The lookup
 * reads `shared.record_image_metadata`, and a content hash is a column of
 * `shared.records`; a second byte-identity check built from a table that cannot
 * answer it would be a second implementation of the one check the library
 * actually enforces.
 *
 * ## Tiers 2 and 3 ship report-only
 *
 * Neither acts. Their thresholds are **unvalidated in the false-positive
 * direction** and the things that decide those thresholds — bursts, panoramas,
 * screenshots, Storage Saver re-encodes — are precisely what a real photo
 * library is full of.
 *
 * A burst of ten frames shot in one second shares a capture second, a camera
 * model, and dimensions, and looks near-identical to a perceptual hash. Every
 * one of those frames is a photo the user chose to keep. Calibrating against a
 * real export is the prerequisite for letting either tier act, and until then
 * "report-only" is not timidity — it is the difference between a useful tool
 * and one that silently eats a burst.
 */

/** How confident a match is, and therefore what may be done about it. */
export type DuplicateTier =
  /**
   * Byte-identical: the content hashes match. The same file, definitionally —
   * there is no interpretation involved and no threshold to get wrong. The
   * only tier that skips a file, and the only one this module does not decide:
   * registration answers it server-side.
   */
  | "identical"
  /**
   * The camera says these are the same exposure: same capture timestamp, same
   * make and model, same native dimensions.
   *
   * Strong but not conclusive, and weaker than it could be. EXIF's
   * `ImageUniqueId` would separate two frames of a burst from two copies of one
   * exposure, and `IMAGE_METADATA_COLUMNS` has no column for it — so no record
   * in the library can carry one and the stronger form is unreachable. Adding
   * the column is a registry change and its own decision; until it lands this
   * tier cannot distinguish a burst from a duplicate, which is exactly why it
   * reports rather than acts.
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

/**
 * The facts about one picture the two comparing tiers read.
 *
 * Every field is optional because every one of them is genuinely absent from
 * real files: a screenshot has no camera, an image a messaging app re-encoded
 * has no EXIF at all, and a record awaiting derivation has no perceptual hash
 * yet.
 */
export interface ImportCandidate {
  readonly capturedAt?: string | null;
  readonly cameraMake?: string | null;
  readonly cameraModel?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly perceptualHash?: string | null;
}

/** One record the library offered as worth comparing against. */
export interface LibraryEntry extends ImportCandidate {
  readonly recordId: string;
  /**
   * For the report, when a caller can supply it.
   *
   * Left unset by the metadata-table lookup, which holds dimensions and EXIF
   * and no filename. A finding then names the record id, which is less
   * friendly and still unambiguous.
   */
  readonly originalFilename?: string | null;
}

export interface DuplicateFinding {
  readonly tier: "same-capture" | "similar";
  readonly existingRecordId: string;
  /** Human-readable reason, for the import report. Never parsed. */
  readonly reason: string;
  /** Always `report`: neither tier here is calibrated to act. See the header. */
  readonly action: "report";
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
 *
 * The fingerprint is also the tier-2 lookup's `where` clause, one column at a
 * time — see `library-lookup.ts`, which derives that clause from this function
 * rather than restating its preconditions.
 */
export function captureFingerprint(candidate: ImportCandidate): string | null {
  if (!candidate.capturedAt) return null;
  // Make/model plus native dimensions is the whole fingerprint, and the reason
  // this tier reports rather than acts: a burst shares all of it. The stronger
  // `ImageUniqueId` form is unreachable — see the `same-capture` tier above.
  if (!candidate.cameraMake && !candidate.cameraModel) return null;
  if (!candidate.width || !candidate.height) return null;
  return `cam:${candidate.capturedAt}:${candidate.cameraMake ?? ""}:${candidate.cameraModel ?? ""}:${candidate.width}x${candidate.height}`;
}

/**
 * Compare one incoming file against the records a lookup proposed for it.
 *
 * `candidates` is a per-candidate answer, not a library: the same-capture rows
 * an indexed metadata query returned, plus whatever the perceptual index holds.
 * Passing the whole library still works and is what the tests do, because the
 * comparison is the same either way — what changed is who pays for the scan.
 *
 * Returns the **strongest** finding only. A file that is the same exposure as
 * something is not also interestingly "similar" to it, and reporting both would
 * bury the one that matters.
 */
export function findDuplicate(
  candidate: ImportCandidate,
  candidates: readonly LibraryEntry[],
  perceptualDistance: (a: string, b: string) => number,
): DuplicateFinding | null {
  // Tier 2 — same capture, per the camera.
  const fingerprint = captureFingerprint(candidate);
  if (fingerprint) {
    for (const entry of candidates) {
      if (captureFingerprint(entry) === fingerprint) {
        return {
          tier: "same-capture",
          existingRecordId: entry.recordId,
          reason: `same capture fingerprint as ${entry.originalFilename ?? entry.recordId}`,
          action: "report",
        };
      }
    }
  }

  // Tier 3 — perceptually similar.
  if (candidate.perceptualHash) {
    for (const entry of candidates) {
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
