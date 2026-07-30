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
import { defaultVisionConfig, VISION_TASK_IDS, type VisionConfig, type VisionTaskId } from "./types";

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

function section(patch: unknown, name: string): Record<string, unknown> | null {
  const value = (patch as Record<string, unknown> | null)?.[name];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function bool(from: Record<string, unknown> | null, key: string, fallback: boolean): boolean {
  return typeof from?.[key] === "boolean" ? (from[key] as boolean) : fallback;
}

/**
 * Field-by-field, per section, with a clamp on `threshold`.
 *
 * Cosine similarity on L2-normalized vectors is bounded by ±1, and the useful
 * band is well inside it: at 0 every face joins the first cluster and at 1
 * nothing ever matches. Clamping to [0.1, 0.95] keeps a fat-fingered PUT from
 * producing a state whose only symptom is "clustering silently stopped".
 *
 * There is deliberately **no early return** for a patch that omits a section.
 * The face-only version bailed with `base` whenever `patch.faces` was absent,
 * which was invisible with one section and becomes data loss with two: a PUT
 * touching only `scene` would be discarded and reported as saved. Every section
 * now falls back to its own slice of `base` independently.
 */
export function mergeVisionConfig(base: VisionConfig, patch: unknown): VisionConfig {
  const faces = section(patch, "faces");
  const scene = section(patch, "scene");
  const objects = section(patch, "objects");
  const threshold = faces?.threshold;
  const objectThreshold = objects?.threshold;
  return {
    faces: {
      enabled: bool(faces, "enabled", base.faces.enabled),
      threshold:
        typeof threshold === "number" && Number.isFinite(threshold)
          ? Math.min(0.95, Math.max(0.1, threshold))
          : base.faces.threshold,
      publishLabels: bool(faces, "publishLabels", base.faces.publishLabels),
    },
    scene: {
      enabled: bool(scene, "enabled", base.scene.enabled),
    },
    objects: {
      enabled: bool(objects, "enabled", base.objects.enabled),
      // Clamped like the face threshold, and for the same class of reason: a
      // sigmoid score outside (0, 1) either never fires or never fails, and both
      // present as "detection silently stopped working".
      threshold:
        typeof objectThreshold === "number" && Number.isFinite(objectThreshold)
          ? Math.min(0.95, Math.max(0.05, objectThreshold))
          : base.objects.threshold,
    },
  };
}

/**
 * Which tasks the current config asks for, in `VISION_TASK_IDS` order.
 *
 * The scan gate, the model check, and the worker's task list all need this and
 * must agree — the worker deciding it has nothing enabled after the host decided
 * it did is a pass that reports success having done nothing.
 */
export function enabledTaskIds(config: VisionConfig): VisionTaskId[] {
  return VISION_TASK_IDS.filter((id) => taskEnabled(config, id));
}

export function taskEnabled(config: VisionConfig, taskId: VisionTaskId): boolean {
  switch (taskId) {
    case "faces":
      return config.faces.enabled;
    case "scene":
      return config.scene.enabled;
    case "objects":
      return config.objects.enabled;
  }
}

export function writeVisionConfig(config: VisionConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
