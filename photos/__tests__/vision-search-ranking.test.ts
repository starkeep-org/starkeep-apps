import { describe, expect, it } from "vitest";
import {
  bandResults,
  DEFAULT_DENSE_FLOOR,
  DEFAULT_WEIGHTS,
  rankCandidates,
  type Candidate,
} from "@/vision/search/ranking";
import { defaultVisionConfig } from "@/vision/types";
import type { StructuredTerm } from "@/vision/search/parse";

/**
 * Additive fusion (plan §5.1).
 *
 * The invariant the whole ranking design exists to serve:
 *
 *     score(Alice ∧ beach) > score(Alice) , score(beach)
 *
 * Everything else here is a consequence of it. The tests are arranged so that if
 * someone "simplifies" fusion into a hard filter, or drops the per-query
 * normalization, a named test says which property they broke.
 */

const alice: StructuredTerm = {
  kind: "person",
  id: "p-alice",
  matched: "Alice",
  label: "Alice",
  count: null,
  from: 0,
  to: 1,
};

const bob: StructuredTerm = { ...alice, id: "p-bob", matched: "Bob", label: "Bob" };

function candidate(recordId: string, dense: number | null, matched: StructuredTerm[] = []): Candidate {
  return { recordId, matched, dense };
}

describe("the additive invariant", () => {
  it("ranks both signals above either alone", () => {
    // The §5.1 table, as a test. Raw cosines are in SigLIP's real band (~0.02–0.11)
    // rather than idealized, because the normalization is what makes them comparable
    // to a 0-or-1 structured match.
    // An explicit floor of 0 so this documents §5.1's *fusion arithmetic* and does not
    // break every time the membership floor is retuned — the floor has its own block
    // below, and the two concerns are now genuinely separate.
    const ranked = rankCandidates(
      [
        candidate("alice-at-beach", 0.11, [alice]),
        candidate("alice-indoors", 0.03, [alice]),
        candidate("best-beach-no-alice", 0.11),
        candidate("neither", 0.03),
      ],
      { denseFloor: 0 },
    );

    // All four rows of §5.1's table, in its order. The fourth used to be missing:
    // membership was decided by normalization, so the pool's dense minimum scored 0
    // and was dropped on every query. It clears the floor, so it belongs here.
    expect(ranked.map((r) => r.recordId)).toEqual([
      "alice-at-beach",
      "alice-indoors",
      "best-beach-no-alice",
      "neither",
    ]);

    const byId = new Map(ranked.map((r) => [r.recordId, r.score]));
    expect(byId.get("alice-at-beach")!).toBeGreaterThan(byId.get("alice-indoors")!);
    expect(byId.get("alice-at-beach")!).toBeGreaterThan(byId.get("best-beach-no-alice")!);
  });

  it("puts every structured match above everything without one", () => {
    // The band property: raising `w_person` sharpens this toward a hard filter and
    // lowering it blends, but at the default ratio the separation is total — even
    // when the un-matched photo is the single best dense hit.
    const ranked = rankCandidates([
      candidate("alice-worst-dense", 0.0, [alice]),
      candidate("no-alice-best-dense", 1.0),
    ]);
    expect(ranked[0].recordId).toBe("alice-worst-dense");
  });

  it("blends the bands when the weight ratio says to", () => {
    // Same inputs, different knob. §11 keeps these tunable precisely so this is a
    // configuration question rather than a code change.
    const ranked = rankCandidates(
      [candidate("alice-worst-dense", 0.0, [alice]), candidate("no-alice-best-dense", 1.0)],
      { person: 0.5, object: 1.5, dense: 1 },
    );
    expect(ranked[0].recordId).toBe("no-alice-best-dense");
  });

  it("adds up multiple structured matches", () => {
    const ranked = rankCandidates([
      candidate("both", 0.05, [alice, bob]),
      candidate("one", 0.05, [alice]),
    ]);
    expect(ranked[0].recordId).toBe("both");
    expect(ranked[0].structured).toBe(DEFAULT_WEIGHTS.person * 2);
  });
});

describe("per-query normalization", () => {
  it("maps the pool's dense range onto [0, 1]", () => {
    // Raw cosine sits in a narrow, uncalibrated, query-dependent band. Without
    // this the weight would have to absorb the band's position, which is what makes
    // weights untunable.
    // All three clear the membership floor, so normalization only sets the weighting.
    const ranked = rankCandidates([
      candidate("high", 0.11),
      candidate("mid", 0.075),
      candidate("low", 0.04),
    ]);
    const byId = new Map(ranked.map((r) => [r.recordId, r.dense]));
    expect(byId.get("high")).toBeCloseTo(1, 6);
    expect(byId.get("mid")).toBeCloseTo(0.5, 6);
    // The weakest admitted candidate normalizes to 0 and is still *returned* — that
    // is the bug this separation fixed. It sorts last; it does not vanish.
    expect(byId.get("low")).toBeCloseTo(0, 6);
    expect(ranked.map((r) => r.recordId)).toEqual(["high", "mid", "low"]);
  });

  it("adapts to wherever the band happens to sit, among admitted candidates", () => {
    // The weighting is pool-relative, so two queries whose cosines differ tenfold
    // rank identically — provided both clear the floor.
    const order = (scale: number) =>
      rankCandidates([
        candidate("a", 0.1 * scale),
        candidate("b", 0.07 * scale),
        candidate("c", 0.04 * scale),
      ]).map((r) => r.recordId);
    expect(order(1)).toEqual(order(10));
  });

  it("is deliberately NOT scale-invariant about membership", () => {
    // The trade the floor buys, stated as a test. A purely relative rule ranks a
    // library of non-matches exactly as confidently as a library of matches — measured
    // on real photos, "a plate of sushi" scores every photo *negative* and still puts
    // three of them above a median/MAD z of 1.0. Being absolute here is what lets
    // "nothing matched" exist at all.
    expect(rankCandidates([candidate("a", 0.1), candidate("b", 0.05)])).toHaveLength(2);
    expect(rankCandidates([candidate("a", 0.01), candidate("b", 0.005)])).toEqual([]);
  });

  it("does not divide by zero when every cosine is identical", () => {
    // A degenerate span normalizes to 1 rather than NaN: with nothing to separate,
    // the structured terms should decide the order, not an erased dense term.
    const ranked = rankCandidates([
      candidate("a", 0.07, [alice]),
      candidate("b", 0.07),
    ]);
    expect(ranked.every((r) => Number.isFinite(r.score))).toBe(true);
    expect(ranked[0].recordId).toBe("a");
    expect(ranked[0].dense).toBe(1);
  });

  it("handles a single-candidate pool", () => {
    const ranked = rankCandidates([candidate("only", 0.04)]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].dense).toBe(1);
    expect(Number.isFinite(ranked[0].score)).toBe(true);
  });
});

describe("pure-structured queries stay exact", () => {
  it("excludes everything that matched nothing", () => {
    // `"photos of Alice"` has no residual, so `dense` is null throughout and only
    // structured matches score — which is a filter, achieved with no special case.
    const ranked = rankCandidates([
      candidate("has-alice", null, [alice]),
      candidate("no-alice", null),
    ]);
    expect(ranked.map((r) => r.recordId)).toEqual(["has-alice"]);
    expect(ranked[0].dense).toBeNull();
  });

  it("returns nothing when no candidate carries any signal", () => {
    expect(rankCandidates([candidate("a", null), candidate("b", null)])).toEqual([]);
  });

  it("returns nothing for an empty pool", () => {
    expect(rankCandidates([])).toEqual([]);
  });
});

describe("graceful degradation", () => {
  it("keeps an undetected-Alice photo via its dense signal alone", () => {
    // §5.1: this subsumes the backfill hack an earlier draft proposed. A photo where
    // Alice is present but undetected still lands in the beach band on its own,
    // through the same mechanism rather than a separate append step.
    const ranked = rankCandidates([
      candidate("alice-detected", 0.09, [alice]),
      candidate("alice-missed-but-beachy", 0.11),
    ]);
    expect(ranked.map((r) => r.recordId)).toContain("alice-missed-but-beachy");
    expect(ranked[0].recordId).toBe("alice-detected");
  });
});

describe("ordering is stable", () => {
  it("breaks ties by record id rather than by store order", () => {
    const forwards = rankCandidates([candidate("b", 0.05), candidate("a", 0.05)]);
    const backwards = rankCandidates([candidate("a", 0.05), candidate("b", 0.05)]);
    expect(forwards.map((r) => r.recordId)).toEqual(backwards.map((r) => r.recordId));
    expect(forwards.map((r) => r.recordId)).toEqual(["a", "b"]);
  });
});

describe("bandResults", () => {
  it("groups by which structured terms fired, in score order", () => {
    const ranked = rankCandidates([
      candidate("alice-beach", 0.11, [alice]),
      candidate("alice-indoors", 0.03, [alice]),
      candidate("beach-only", 0.1),
    ]);
    const bands = bandResults(ranked);
    expect(bands).toHaveLength(2);
    expect(bands[0].terms.map((t) => t.id)).toEqual(["p-alice"]);
    expect(bands[0].results.map((r) => r.recordId)).toEqual(["alice-beach", "alice-indoors"]);
    expect(bands[1].terms).toEqual([]);
    expect(bands[1].results.map((r) => r.recordId)).toEqual(["beach-only"]);
  });

  it("returns one band when nothing structured fired", () => {
    const bands = bandResults(rankCandidates([candidate("a", 0.1), candidate("b", 0.05)]));
    expect(bands).toHaveLength(1);
    expect(bands[0].terms).toEqual([]);
  });

  it("returns nothing for no results", () => {
    expect(bandResults([])).toEqual([]);
  });
});

describe("the dense membership floor", () => {
  it("matches the default the config ships", () => {
    // Duplicated across modules to avoid an import cycle, so pinned to each other.
    expect(DEFAULT_DENSE_FLOOR).toBe(defaultVisionConfig().search.denseFloor);
  });

  it("excludes a photo whose description score is below the floor", () => {
    const ranked = rankCandidates([candidate("match", 0.08), candidate("noise", 0.01)]);
    expect(ranked.map((r) => r.recordId)).toEqual(["match"]);
  });

  it("returns nothing when no photo clears the floor", () => {
    // The state that was previously unreachable: a description query always returned
    // `poolSize − 1` results, so "nothing matched" could not be expressed.
    expect(rankCandidates([candidate("a", 0.01), candidate("b", 0.02), candidate("c", -0.03)])).toEqual([]);
  });

  it("admits an exact match whatever its description score", () => {
    // A person or a class is a lookup, not a similarity — the floor is a statement
    // about uncalibrated cosines and has no business gating an exact signal.
    const ranked = rankCandidates([candidate("alice-in-the-dark", -0.05, [alice])]);
    expect(ranked.map((r) => r.recordId)).toEqual(["alice-in-the-dark"]);
  });

  it("honours an overridden floor", () => {
    const candidates = [candidate("a", 0.08), candidate("b", 0.05), candidate("c", 0.02)];
    expect(rankCandidates(candidates, { denseFloor: 0 })).toHaveLength(3);
    expect(rankCandidates(candidates, { denseFloor: 0.06 })).toHaveLength(1);
  });

  it("normalizes over the admitted pool, not every candidate", () => {
    // Including rejects would let a photo that failed the floor set the bottom of the
    // range and compress everything that passed it into the top of the scale.
    const withReject = rankCandidates([
      candidate("high", 0.10),
      candidate("low", 0.05),
      candidate("rejected", -0.20),
    ]);
    const without = rankCandidates([candidate("high", 0.10), candidate("low", 0.05)]);
    expect(withReject.map((r) => r.dense)).toEqual(without.map((r) => r.dense));
  });

  it("still accepts bare weights, for callers that pass them positionally", () => {
    const ranked = rankCandidates([candidate("a", 0.08, [alice])], {
      person: 0.5,
      object: 1.5,
      dense: 1,
    });
    expect(ranked[0].structured).toBe(0.5);
  });
});
