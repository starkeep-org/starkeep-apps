/**
 * Who owns the process for the duration of one tick.
 *
 * ## Why this is a module rather than two lines in the task
 *
 * `background-task.ts` holds wiring and nothing decidable, because it cannot
 * run under Node. This is decidable — it is a rule about a clock and a claim —
 * and it is the rule whose absence wedged the app, so it is exactly the kind of
 * thing that should be provable on a laptop.
 *
 * ## The rule, and what it is defending against
 *
 * A window is one tick. The OS has delivered this task twice, thirty
 * milliseconds apart, into the same JavaScript runtime, and both deliveries ran
 * a tick that then queued behind the other on the node's own serialization.
 *
 * The first version of the guard therefore refused any delivery arriving while
 * a tick was running, and that refusal was unconditional. Unconditional is what
 * broke it. A tick spent over nine minutes inside one uninterruptible
 * media-store call; JobScheduler stopped the session at its ten-minute ceiling,
 * **which does not stop the JavaScript**; and Android's cached-app freezer then
 * suspended the process mid-call. The freezer thaws a process to deliver work
 * and refreezes it after, so every later delivery woke the process, met a claim
 * nothing would ever release, returned immediately, and let it refreeze. The app
 * was wedged until something killed the process — and each dropped delivery
 * also spent one of the three job sessions Android's RARE bucket allows per day.
 *
 * So a claim expires. Inside its window a second delivery still defers, which
 * is the case the guard was added for. Beyond it the holder is over its budget
 * and is either frozen or lost, and deferring to it accomplishes nothing.
 *
 * ## Why expiry rather than self-release
 *
 * A frozen tick cannot release anything: nothing in the process runs to notice
 * its own deadline passing. The release therefore has to be a judgement the
 * *next* delivery makes about a claim it finds, from the clock alone. A claim is
 * data with a timestamp, not a promise somebody has to remember to resolve.
 */

/** A claim on the process, held for the duration of one tick. */
export interface Claim {
  /** Wall-clock time after which another delivery may take the process. */
  readonly expiresAt: number;
}

export type ClaimDecision =
  /** No live claim. This delivery runs the tick. */
  | { readonly kind: "proceed" }
  /** A live claim held by a tick still inside its budget. Do nothing. */
  | { readonly kind: "defer" }
  /** A claim past its expiry. Take the process, and say so. */
  | { readonly kind: "take-over"; readonly overdueByMs: number };

/**
 * What a delivery arriving now should do about the claim it finds.
 *
 * Split from taking the claim so the decision is a pure function of the claim
 * and the clock. The three outcomes are distinguished rather than collapsed into
 * a boolean because they need different words in the log, and "this delivery did
 * nothing" and "the previous tick never came back" are the two states that were
 * indistinguishable while the app was wedged.
 */
export function decideClaim(held: Claim | null, nowMs: number): ClaimDecision {
  if (held === null) return { kind: "proceed" };
  if (nowMs < held.expiresAt) return { kind: "defer" };
  return { kind: "take-over", overdueByMs: nowMs - held.expiresAt };
}

/**
 * How long a claim outlives the budget of the tick holding it.
 *
 * A margin rather than a second budget. A tick that is a little over its
 * deadline is finishing the job in flight and should not be raced; a tick that
 * is thirty seconds over has been stopped by the OS, and the next delivery is
 * the only thing that will ever notice.
 */
export const CLAIM_GRACE_MS = 30_000;

export function claimFor(nowMs: number, budgetMs: number): Claim {
  return { expiresAt: nowMs + budgetMs + CLAIM_GRACE_MS };
}
