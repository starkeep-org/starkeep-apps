/**
 * Read/write `app-local/photos/vision/config.json`.
 *
 * Reads never throw: a missing or corrupt file is the default config, because
 * the alternative is a Settings panel that cannot render — and therefore cannot
 * be used to fix the file — after a bad write.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths";
import { defaultVisionConfig, type VisionConfig } from "./types";

export function readVisionConfig(): VisionConfig {
  const defaults = defaultVisionConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath(), "utf-8"));
  } catch {
    return defaults;
  }
  return mergeVisionConfig(defaults, raw);
}

/**
 * Field-by-field, with a clamp on `threshold`.
 *
 * Cosine similarity on L2-normalized vectors is bounded by ±1, and the useful
 * band is well inside it: at 0 every face joins the first cluster and at 1
 * nothing ever matches. Clamping to [0.1, 0.95] keeps a fat-fingered PUT from
 * producing a state whose only symptom is "clustering silently stopped".
 */
export function mergeVisionConfig(base: VisionConfig, patch: unknown): VisionConfig {
  const faces = (patch as { faces?: Record<string, unknown> } | null)?.faces;
  if (!faces || typeof faces !== "object") return base;
  return {
    faces: {
      enabled: typeof faces.enabled === "boolean" ? faces.enabled : base.faces.enabled,
      threshold:
        typeof faces.threshold === "number" && Number.isFinite(faces.threshold)
          ? Math.min(0.95, Math.max(0.1, faces.threshold))
          : base.faces.threshold,
      publishLabels:
        typeof faces.publishLabels === "boolean" ? faces.publishLabels : base.faces.publishLabels,
    },
  };
}

export function writeVisionConfig(config: VisionConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
