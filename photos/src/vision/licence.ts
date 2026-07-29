/**
 * The antelopev2 weights' licence, and the record that someone accepted it.
 *
 * InsightFace's *code* is MIT; the pretrained weights — antelopev2 included —
 * are released for **non-commercial research use only**. That distinction is
 * exactly the one that gets lost, so nothing downloads them without an explicit
 * acceptance: `pnpm vision:fetch-models` prompts, and the Faces panel's download
 * button is labelled as accepting.
 *
 * Shared because there are now two of those entry points and one wording. A
 * second copy of the notice is a second copy that can quietly go stale.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelsDir } from "./paths";

export const ACK_FILE = "LICENCE-ACKNOWLEDGED.txt";

export const LICENCE_NOTICE = `
  The antelopev2 models come from InsightFace. Its *code* is MIT-licensed, but
  the training data and the pretrained weights — antelopev2 included — are
  released for NON-COMMERCIAL RESEARCH USE ONLY.

    https://github.com/deepinsight/insightface
    https://github.com/deepinsight/insightface/issues/2022

  Downloading them means you accept that restriction. Starkeep does not
  redistribute these weights and does not fetch them without this step.
`;

/** One line of it, for a UI that has room for one line. */
export const LICENCE_SUMMARY = "non-commercial research use only";

/**
 * Records the acceptance next to the files it applies to.
 *
 * Beside the weights rather than in the config, because that is where someone
 * finding 278 MB of unexplained ONNX on their disk will look — and because
 * deleting the models deletes the record of a decision that no longer applies
 * to anything.
 */
export function writeLicenceAcknowledgement(via: string): void {
  const dir = modelsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ACK_FILE),
    `antelopev2 weights: non-commercial research use only (InsightFace).\n` +
      `Acknowledged ${new Date().toISOString()} via ${via}.\n` +
      `${LICENCE_NOTICE.trim()}\n`,
    "utf-8",
  );
}
