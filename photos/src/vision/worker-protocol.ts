/**
 * The messages the Next server and the scan worker exchange.
 *
 * Its own module, with no ONNX and no `worker_threads` import, because both
 * sides need these types and only one of them may be reachable from `app/`.
 */

import type { ScanState, VisionConfig } from "./types";

/** Host → worker. */
export type ScanCommand =
  | {
      type: "start";
      config: VisionConfig;
      /** Absolute paths, resolved host-side so the worker owns no path policy. */
      detectorPath: string;
      embedderPath: string;
    }
  | { type: "stop" };

/** Worker → host. */
export type ScanEvent =
  | { type: "progress"; state: ScanState }
  | { type: "finished"; state: ScanState }
  | { type: "failed"; message: string };

/** How often the worker reports upward. Cheap, and the UI polls at 1 s. */
export const PROGRESS_INTERVAL_MS = 750;
