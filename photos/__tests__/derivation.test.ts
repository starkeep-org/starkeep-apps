/**
 * Derivation state and the attempt ledger.
 *
 * The image encoding itself is not tested here — it is sharp, and asserting
 * that sharp resizes is asserting sharp. What is tested is everything that
 * decides *whether work happens*, which is where the failures are silent: a
 * ladder that reports itself complete when it isn't lets an original be
 * archived with nothing readable in its place, and an attempt ledger that
 * forgets a permanent failure re-downloads an entire HEIC library every day.
 */
import { describe, it, expect } from "vitest";
import {
  missingRenditionClasses,
  ladderIsComplete,
  cloudCanDecode,
  CLOUD_DECODABLE_TYPES,
} from "../src/photos-lib/image-processing/derive-ladder";
import {
  shouldAttemptDerivation,
  recordAttempt,
  backoffMs,
  fallbackIsDue,
  DERIVATION_FALLBACK_HOURS,
  type DerivationAttempt,
} from "../src/photos-lib/image-processing/derivation-attempts";
import { STILL_LADDER, applicableStillClasses } from "../src/photos-lib/ladder";

const allClassesFor = (longEdge: number) =>
  applicableStillClasses(longEdge).map((s) => s.sizeClass as string);

describe("derivation state is a query, not a field", () => {
  it("reports every applicable rung missing when none exist", () => {
    const big = STILL_LADDER[STILL_LADDER.length - 1]!.maxLongEdge + 1;
    expect(missingRenditionClasses(big, [])).toEqual(allClassesFor(big));
  });

  it("reports nothing missing once every applicable rung exists", () => {
    const big = 5000;
    expect(missingRenditionClasses(big, allClassesFor(big))).toEqual([]);
    expect(ladderIsComplete(big, allClassesFor(big))).toBe(true);
  });

  // The archive gate's predicate. An original may only be frozen once something
  // cheaper is readable in its place, so a ladder that reports complete while a
  // rung is missing puts the only readable copy behind a 48-hour thaw.
  it("is not complete while any applicable rung is absent", () => {
    const big = 5000;
    const all = allClassesFor(big);
    for (let i = 0; i < all.length; i++) {
      const missingOne = all.filter((_, j) => j !== i);
      expect(ladderIsComplete(big, missingOne), all[i]).toBe(false);
    }
  });

  // A small original applies fewer rungs, so it is complete with fewer of them.
  // Requiring the whole ladder would leave every small photo permanently
  // ineligible for archiving — and permanently re-attempted by the sweeper.
  it("does not demand rungs that do not apply to a small original", () => {
    const small = STILL_LADDER[0]!.maxLongEdge;
    expect(ladderIsComplete(small, [STILL_LADDER[0]!.sizeClass])).toBe(true);
  });

  // Extra classes are not an error: a respec can leave a superseded rung around
  // until the reaper takes it, and that must not read as incomplete.
  it("ignores classes it did not ask for", () => {
    const small = STILL_LADDER[0]!.maxLongEdge;
    expect(ladderIsComplete(small, [STILL_LADDER[0]!.sizeClass, "image-large"])).toBe(true);
  });
});

describe("what the cloud fallback can reach", () => {
  // The custom libvips build that would add HEIC and raw is rejected for now,
  // so the fallback simply cannot reach those records. Saying so explicitly is
  // what lets the sweeper record "undecodable here" once instead of retrying.
  it("covers exactly the four formats the plan names", () => {
    expect([...CLOUD_DECODABLE_TYPES].sort()).toEqual([
      "image/avif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });

  it("cannot decode HEIC or raw — the formats a phone library is mostly made of", () => {
    for (const type of ["image/heic", "image/heif", "image/dng", "image/cr3", "image/nef"]) {
      expect(cloudCanDecode(type), type).toBe(false);
    }
  });
});

const attempt = (over: Partial<DerivationAttempt> = {}): DerivationAttempt => ({
  recordId: "r1",
  outcome: "transient-failure",
  attemptedAtMs: 1000,
  consecutiveFailures: 1,
  ...over,
});

describe("the attempt ledger decides whether to try again", () => {
  it("tries a record nobody has attempted", () => {
    expect(shouldAttemptDerivation(null, 0).attempt).toBe(true);
  });

  // The one permanent outcome, and the reason the ledger exists at all: without
  // it the cloud sweeper re-downloads and re-fails on every HEIC in the library
  // daily, forever.
  it("never retries a format this node cannot decode", () => {
    const verdict = shouldAttemptDerivation(
      attempt({ outcome: "undecodable-here" }),
      Number.MAX_SAFE_INTEGER,
    );
    expect(verdict.attempt).toBe(false);
    expect(verdict.reason).toMatch(/cannot decode/);
  });

  // Backoff is the wrong tool here: the fix is a transfer, not another attempt.
  it("does not back off a record whose bytes simply are not here", () => {
    const verdict = shouldAttemptDerivation(
      attempt({ outcome: "source-unavailable" }),
      Number.MAX_SAFE_INTEGER,
    );
    expect(verdict.attempt).toBe(false);
    expect(verdict.reason).toMatch(/not on this node/);
  });

  it("backs off a transient failure and retries once the wait elapses", () => {
    const a = attempt({ attemptedAtMs: 1000, consecutiveFailures: 1 });
    expect(shouldAttemptDerivation(a, 1000).attempt).toBe(false);
    expect(shouldAttemptDerivation(a, 1000 + backoffMs(1)).attempt).toBe(true);
  });

  it("backs off further with each consecutive failure, up to a cap", () => {
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
    expect(backoffMs(5)).toBeGreaterThan(backoffMs(4));
    // The cap matters more than the curve: an unbounded backoff eventually
    // means "never", and a record that failed six times for six unrelated
    // reasons is not one to abandon.
    expect(backoffMs(50)).toBe(backoffMs(100));
    expect(backoffMs(50)).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  // The ladder query is the authority on whether work remains. A `complete`
  // attempt must not block a retry after a respec or a reaped child.
  it("retries a previously-complete record, because the query is the authority", () => {
    expect(shouldAttemptDerivation(attempt({ outcome: "complete" }), 0).attempt).toBe(true);
  });
});

describe("recording an attempt", () => {
  it("accumulates consecutive transient failures", () => {
    let a = recordAttempt(null, "r1", "transient-failure", 1);
    expect(a.consecutiveFailures).toBe(1);
    a = recordAttempt(a, "r1", "transient-failure", 2);
    expect(a.consecutiveFailures).toBe(2);
  });

  // A record that fails twice, succeeds, then fails again starts its backoff
  // from the beginning rather than from an hour.
  it("resets the count on any non-transient outcome", () => {
    const failedTwice = attempt({ consecutiveFailures: 2 });
    expect(recordAttempt(failedTwice, "r1", "complete", 5).consecutiveFailures).toBe(0);
    expect(recordAttempt(failedTwice, "r1", "undecodable-here", 5).consecutiveFailures).toBe(0);
  });

  it("keeps detail for the inspector without parsing it", () => {
    const a = recordAttempt(null, "r1", "undecodable-here", 1, "no HEIC decoder");
    expect(a.detail).toBe("no HEIC decoder");
  });
});

describe("the cloud fallback is a delay, not a race", () => {
  const HOUR = 60 * 60 * 1000;

  // The originating node owns derivation indefinitely and retries from its own
  // queue. This is not a handover to a competitor but a fallback for the node
  // being gone, wiped, or permanently unable — so it waits long enough that an
  // ordinary phone gets its chance overnight, on wifi, on a charger.
  it("does not take over before the window elapses", () => {
    const created = 0;
    expect(fallbackIsDue(created, (DERIVATION_FALLBACK_HOURS - 1) * HOUR)).toBe(false);
    expect(fallbackIsDue(created, DERIVATION_FALLBACK_HOURS * HOUR)).toBe(true);
  });

  it("is configurable, because a laptop-only library has no phone to wait for", () => {
    expect(fallbackIsDue(0, 2 * HOUR, 1)).toBe(true);
    expect(fallbackIsDue(0, 2 * HOUR, 48)).toBe(false);
  });
});
