/**
 * The JavaScript face of {@link StarkeepTimerModule}.
 *
 * Two calls and no state: `delay` resolves after a delay that does not run on
 * `Choreographer`, and `cancel` settles a delay early. Everything built on top
 * of the pair — a `Timers` implementation, deadlines, abort signals — lives in
 * `src/work/native-timers.ts` and `src/deadline.ts`, where it can be tested
 * without a handset.
 */

import { requireOptionalNativeModule } from "expo";

export interface StarkeepTimer {
  /**
   * Resolve true once `ms` has passed, or false if {@link cancel} reaches the
   * same `id` first.
   *
   * The caller supplies the id rather than receiving one, because a handle
   * returned by a promise arrives too late to cancel a delay that has already
   * been armed.
   */
  delay(id: number, ms: number): Promise<boolean>;
  /** Settle the delay holding `id` as false. A no-op for an id already settled. */
  cancel(id: number): void;
}

/**
 * Null when the native module is not in the binary.
 *
 * Optional rather than required, because a development client built before this
 * module existed would otherwise crash on the first import in `platform.ts` —
 * at launch, on every path, for a module that only matters in a background
 * window. `native-timers.ts` says loudly what it falls back to.
 */
export default requireOptionalNativeModule<StarkeepTimer>("StarkeepTimer");
