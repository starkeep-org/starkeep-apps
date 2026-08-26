/**
 * What a derivation sweep is doing, and what the last one did.
 *
 * Shaped after `vision/types.ts` for the same reasons: the status route and the
 * worker both need these types, and only one of them may be reachable from
 * `app/` — so they live in a module that imports neither sharp nor
 * `worker_threads`.
 */

/**
 * The two passes a sweep makes over the library.
 *
 * Ordering rungs *within* a record is not enough. That still puts the seventh
 * photo's 400 px tile behind the first photo's 4272 px rung, so a grid fills in
 * thirty seconds rather than half a second. The sweep therefore stages across
 * the *whole library*: everything cheap for every record, then the expensive
 * rungs.
 *
 * Two stages rather than the four the sizes suggest, because the decode is what
 * costs. The placeholder, the record's dimensions and EXIF, and the two bottom
 * rungs all come out of one decode, so they are one unit of work. Everything
 * above pays a second decode and is the other. That is a deliberate two-decode
 * structure — not the theoretical minimum, but a large saving against the nine
 * decodes per record this replaced.
 */
export type SweepStage =
  /** Placeholder, dimensions, EXIF, and the two smallest rungs. */
  | "cheap"
  /** Everything else the record's ladder calls for. */
  | "full"
  | "video";

export const SWEEP_STAGES: readonly SweepStage[] = ["cheap", "full", "video"];

export interface SweepState {
  /** Whether a pass is running right now, as of the last write. */
  running: boolean;
  /** Whether every stage reached the end of its catalogue scan. */
  completed: boolean;
  /** Which stage the current or last pass was in. */
  stage: SweepStage;
  /**
   * The listing cursor within the current stage.
   *
   * This is what makes a sweep resumable rather than restartable. A pass killed
   * two thirds of the way through a 60k library and then restarted from the top
   * would spend its first twenty minutes re-asking questions it has already
   * answered — which is the same waste, in a different costume, as the page
   * load that used to re-derive the library on every render.
   */
  cursor: string | null;
  /** Records examined in this stage so far. */
  examined: number;
  /** Records that needed nothing. */
  skipped: number;
  /** Records this pass actually derived something for. */
  derived: number;
  /** Records that failed. Counted, not retried within a pass. */
  failed: number;
  /** Records this node has decided it cannot decode. */
  undecodable: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export function emptySweepState(): SweepState {
  return {
    running: false,
    completed: false,
    stage: "cheap",
    cursor: null,
    examined: 0,
    skipped: 0,
    derived: 0,
    failed: 0,
    undecodable: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}
