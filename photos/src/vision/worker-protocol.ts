/**
 * The messages the Next server and the scan worker exchange.
 *
 * Its own module, with no ONNX and no `worker_threads` import, because both
 * sides need these types and only one of them may be reachable from `app/`.
 */

import type { ScanState, VisionConfig, VisionTaskId } from "./types";

/**
 * The ONNX graphs one task needs, keyed by the task's own role names —
 * `detector` and `embedder` for faces, and whatever the next task calls its own.
 *
 * A map rather than named fields because the host resolves paths for every
 * enabled task and must not know what any of them are for: naming
 * `detectorPath` on the command is exactly the coupling that made the start
 * command face-shaped (plan §3.2).
 */
export type TaskModelPaths = Record<string, string>;

/** Host → worker. */
export type ScanCommand =
  | {
      type: "start";
      config: VisionConfig;
      /**
       * Absolute paths per enabled task, resolved host-side so the worker owns
       * no path policy. Only enabled tasks appear — a task missing from the map
       * is one the worker must not construct an engine for.
       */
      models: Partial<Record<VisionTaskId, TaskModelPaths>>;
    }
  | { type: "stop" };

/** Worker → host. */
export type ScanEvent =
  | { type: "progress"; state: ScanState }
  | { type: "finished"; state: ScanState }
  | { type: "failed"; message: string };

/** How often the worker reports upward. Cheap, and the UI polls at 1 s. */
export const PROGRESS_INTERVAL_MS = 750;
