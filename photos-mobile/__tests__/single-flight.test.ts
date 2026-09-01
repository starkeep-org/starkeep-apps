import { describe, expect, it } from "vitest";
import { CLAIM_GRACE_MS, claimFor, decideClaim } from "../src/work/single-flight";

const BUDGET = 90_000;

describe("deciding what a delivery does about the claim it finds", () => {
  it("proceeds when nothing holds the process", () => {
    expect(decideClaim(null, 1_000)).toEqual({ kind: "proceed" });
  });

  it("defers to a tick still inside its claim", () => {
    // The case the guard was added for: the OS delivered this task twice, 30ms
    // apart, into one runtime, and both ran a tick.
    const claim = claimFor(0, BUDGET);

    expect(decideClaim(claim, 30)).toEqual({ kind: "defer" });
  });

  it("defers for the whole budget and the grace after it", () => {
    const claim = claimFor(0, BUDGET);

    expect(decideClaim(claim, BUDGET).kind).toBe("defer");
    expect(decideClaim(claim, BUDGET + CLAIM_GRACE_MS - 1).kind).toBe("defer");
  });

  it("takes the process over once the claim has expired", () => {
    // The wedge this exists to break. A tick frozen mid-call releases nothing,
    // so the only thing that can ever free the process is a later delivery
    // deciding the holder is not coming back.
    const claim = claimFor(0, BUDGET);

    expect(decideClaim(claim, BUDGET + CLAIM_GRACE_MS)).toEqual({
      kind: "take-over",
      overdueByMs: 0,
    });
  });

  it("reports how far past its claim the previous tick is", () => {
    // Carried rather than counted: a wedge that names its own duration is the
    // difference between a diagnosable failure and a silent one.
    const claim = claimFor(0, BUDGET);

    expect(decideClaim(claim, BUDGET + CLAIM_GRACE_MS + 7_000)).toEqual({
      kind: "take-over",
      overdueByMs: 7_000,
    });
  });

  it("never defers forever, whatever the budget", () => {
    // The property that actually matters. The failure on the handset was a
    // claim with no expiry at all, and every delivery for hours afterwards was
    // dropped against it.
    for (const budget of [0, 1_000, BUDGET, 9 * 60_000]) {
      const claim = claimFor(0, budget);
      expect(decideClaim(claim, budget + CLAIM_GRACE_MS + 1).kind).toBe("take-over");
    }
  });
});
