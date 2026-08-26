/**
 * The ideal-and-fallback rule.
 *
 * The three cases the plan puts on record are here as named tests, because each
 * of them is a situation a bare "here is the best-fitting rendition" cannot
 * express and a client therefore cannot act on correctly.
 *
 * Every assertion is expressed in terms of the ladder rather than against
 * literal pixel sizes. The ladder's integers are provisional pending a visual
 * test, and a test that pinned `1280` would have to be edited by the same
 * change that makes it wrong — which is exactly when nobody is thinking about
 * whether it *should* be.
 */
import { describe, it, expect } from "vitest";
import {
  resolveRendition,
  resolveRenditions,
  resolveWithoutDimensions,
  type DerivedChild,
} from "../src/rendition-resolution";
import { STILL_LADDER, applicableStillClasses, renditionLongEdge } from "../src/ladder";

const BOTTOM = STILL_LADDER[0]!;
const TOP = STILL_LADDER[STILL_LADDER.length - 1]!;

/** Long edges a source of this size would eventually have, ascending. */
function ladderEdges(sourceLongEdge: number): number[] {
  return applicableStillClasses(sourceLongEdge).map((spec) =>
    renditionLongEdge(spec, sourceLongEdge),
  );
}

function child(longEdge: number): DerivedChild {
  return {
    id: `child-${longEdge}`,
    longEdge,
    width: longEdge,
    height: Math.round(longEdge * 0.75),
    type: "image/avif",
    url: `https://renditions.invalid/${longEdge}`,
  };
}

// A source above the top of the ladder, so every rung applies to it.
const BIG = TOP.maxLongEdge + 500;

describe("a rung that has been derived", () => {
  it("comes back as the ideal, with a URL and no fallback", async () => {
    const edges = ladderEdges(BIG);
    const target = edges[2]!;
    const { ideal, fallback } = resolveRendition(target, {
      sourceLongEdge: BIG,
      candidates: edges.map(child),
    });
    expect(ideal.available).toBe(true);
    expect(ideal.longEdge).toBe(target);
    expect(ideal.url).toBeTypeOf("string");
    expect(fallback).toBeUndefined();
  });
});

describe("a rung that has not been derived", () => {
  it("comes back unavailable, with the largest smaller rung to paint meanwhile", () => {
    const edges = ladderEdges(BIG);
    const target = edges[2]!;
    // Everything below the ideal exists; the ideal and above do not.
    const { ideal, fallback } = resolveRendition(target, {
      sourceLongEdge: BIG,
      candidates: edges.slice(0, 2).map(child),
    });
    expect(ideal.available).toBe(false);
    expect(ideal.longEdge).toBe(target);
    expect(ideal.url).toBeUndefined();
    expect(ideal.state).toBe("pending");
    expect(fallback?.longEdge).toBe(edges[1]);
    expect(fallback?.available).toBe(true);
  });

  it("has no fallback when nothing below it exists", () => {
    const edges = ladderEdges(BIG);
    const { ideal, fallback } = resolveRendition(edges[2]!, {
      sourceLongEdge: BIG,
      candidates: [],
    });
    expect(ideal.available).toBe(false);
    expect(fallback).toBeUndefined();
  });

  it("carries the reason, so a client can tell 'not yet' from 'not here'", () => {
    const { ideal } = resolveRendition(ladderEdges(BIG)[2]!, {
      sourceLongEdge: BIG,
      candidates: [],
      unavailableState: "undecodable-here",
    });
    expect(ideal.state).toBe("undecodable-here");
  });
});

describe("a rung above the ideal is never consulted", () => {
  // Using a larger rung as the placeholder means fetching the expensive thing
  // first and the correct thing second — and under Intelligent-Tiering, reading
  // a large object promotes it back to Frequent Access for thirty days, so a
  // rule that reached upward for a thumbnail would undo the tiering on exactly
  // the renditions tiering exists to make cheap.
  it("prefers a smaller available rung over a larger one", () => {
    const edges = ladderEdges(BIG);
    const { ideal, fallback } = resolveRendition(edges[2]!, {
      sourceLongEdge: BIG,
      // The rung below the ideal and the rung above it, but not the ideal.
      candidates: [child(edges[1]!), child(edges[3]!)],
    });
    expect(ideal.available).toBe(false);
    expect(fallback?.longEdge).toBe(edges[1]);
  });

  it("returns that larger rung as the ideal for a larger target", () => {
    const edges = ladderEdges(BIG);
    const { ideal } = resolveRendition(edges[3]!, {
      sourceLongEdge: BIG,
      candidates: [child(edges[1]!), child(edges[3]!)],
    });
    expect(ideal.available).toBe(true);
    expect(ideal.longEdge).toBe(edges[3]);
  });
});

describe("a source smaller than the size asked for", () => {
  // The case an upgrade watcher must not treat as an opportunity: nothing is
  // pending, this is as good as this photo gets, and a client keyed on "smaller
  // than I asked for" would wait forever for a rung nobody will derive.
  const SMALL = BOTTOM.maxLongEdge + 1;

  it("names the record's top rung as the ideal", () => {
    const edges = ladderEdges(SMALL);
    const huge = TOP.maxLongEdge * 2;
    const { ideal } = resolveRendition(huge, {
      sourceLongEdge: SMALL,
      candidates: edges.map(child),
    });
    expect(ideal.longEdge).toBe(edges[edges.length - 1]);
    // Available, not pending. It exists and nothing better is coming.
    expect(ideal.available).toBe(true);
  });

  it("clamps that rung to the source rather than to the class maximum", () => {
    const edges = ladderEdges(SMALL);
    expect(Math.max(...edges)).toBe(SMALL);
  });
});

describe("resolving several sizes at once", () => {
  it("keys by exactly what was asked for", () => {
    const edges = ladderEdges(BIG);
    const resolved = resolveRenditions([edges[1]!, edges[3]!], {
      sourceLongEdge: BIG,
      candidates: edges.map(child),
    });
    expect(Object.keys(resolved).sort()).toEqual(
      [String(edges[1]), String(edges[3])].sort(),
    );
  });
});

describe("a record with no stored dimensions", () => {
  // No applicable set can be computed, so an existing child is the only honest
  // available answer. With no children, a provisional pending decision keeps
  // child-only writes visible to clients using a parent-based cursor.
  it("falls back to resolving among what exists, and calls it final", () => {
    const resolved = resolveWithoutDimensions([500], [child(400), child(1280)]);
    expect(resolved["500"]!.ideal.available).toBe(true);
    expect(resolved["500"]!.ideal.longEdge).toBe(1280);
    expect(resolved["500"]!.fallback).toBeUndefined();
  });

  it("reports requested targets as provisionally pending when it has no renditions", () => {
    expect(resolveWithoutDimensions([500, 2048], [])).toEqual({
      "500": { ideal: { longEdge: 500, available: false, state: "pending" } },
      "2048": { ideal: { longEdge: 2048, available: false, state: "pending" } },
    });
  });

  it("preserves the node's terminal decode verdict in a provisional decision", () => {
    expect(resolveWithoutDimensions([500], [], "undecodable-here")).toEqual({
      "500": {
        ideal: { longEdge: 500, available: false, state: "undecodable-here" },
      },
    });
  });
});
