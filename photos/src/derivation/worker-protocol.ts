/**
 * The messages the Next server and the derivation worker exchange.
 *
 * Its own module, with no sharp and no `worker_threads` import, because both
 * sides need these types and only one of them may be reachable from `app/`.
 */

import type { SweepState } from "./types";

/** Host → worker. */
export type SweepCommand =
  | {
      type: "start";
      /**
       * Resume from a stored cursor rather than restarting. The host reads it,
       * so the worker owns no state policy.
       */
      resume: Pick<SweepState, "stage" | "cursor">;
      /** How many records to derive at once. See the note in the worker. */
      concurrency: number;
    }
  | { type: "stop" };

/** Worker → host. */
export type SweepEvent =
  | { type: "progress"; state: SweepState }
  | { type: "finished"; state: SweepState }
  | { type: "failed"; message: string };

/** How often the worker reports upward. Cheap, and the UI polls at 1 s. */
export const PROGRESS_INTERVAL_MS = 750;
