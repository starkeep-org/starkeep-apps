/**
 * The "face detector".
 *
 * There is no detection here — this app exists to exercise the cross-app label
 * mechanism, not to find faces, so the shape of what it publishes matters and
 * the accuracy of it does not. When real face detection lands it replaces this
 * function behind the same two labels and nothing else moves.
 *
 * Deterministic in the record id so a re-run produces the same answer, which
 * makes the whole indexing pass idempotent and therefore safe to retry.
 */
export function detectFaceCount(recordId: string): number {
  let hash = 0;
  for (const ch of recordId) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  // 0–3 faces. Zero is deliberately in range: an image with no faces must be
  // *unlabelled*, not labelled zero, or a presence query stops meaning
  // anything.
  return hash % 4;
}
