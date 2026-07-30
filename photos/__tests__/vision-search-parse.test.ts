import { describe, expect, it } from "vitest";
import { parseQuery, termKey, withoutTerms, type Vocabularies } from "@/vision/search/parse";

/**
 * The lexical parse (plan §5).
 *
 * Pure logic, so no models and no disk. What is worth pinning is the handful of
 * cases where a naive implementation is wrong in a way that quietly poisons
 * ranking rather than failing:
 *
 *   - **Longest match.** A library with both "Mary" and "Mary Jane" must not match
 *     the shorter name and leave "Jane" in the residual, where it reads as a
 *     plausible scene word.
 *   - **Name collisions with common nouns** — Rose, Daisy, Iris, Summer, Mark.
 *     §5.2's whole reason for chips: the parse cannot resolve these, so it must at
 *     least be *undoable*.
 *   - **Dropping a chip returns the word to the residual**, rather than deleting
 *     it. Removing the person reading of "rose at the beach" should search for the
 *     flower, not for "at the beach" alone.
 */

function vocab(people: Record<string, string>, objects = false): Vocabularies {
  return { people: new Map(Object.entries(people)), objects };
}

const ALICE = vocab({ "p-alice": "Alice" });

describe("parseQuery", () => {
  it("splits a name from the rest of the query", () => {
    const parsed = parseQuery("Alice at the beach", ALICE);
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.terms[0]).toMatchObject({ kind: "person", id: "p-alice", label: "Alice" });
    expect(parsed.residual).toBe("at the beach");
  });

  it("leaves a query with no known name entirely to the dense stage", () => {
    const parsed = parseQuery("at the beach", ALICE);
    expect(parsed.terms).toEqual([]);
    expect(parsed.residual).toBe("at the beach");
  });

  it("produces no residual for a pure-structured query", () => {
    // §5.1 depends on this: with no residual there is no dense term, so everything
    // scoring zero is excluded — which is exactly a filter, with no special case.
    const parsed = parseQuery("Alice", ALICE);
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.residual).toBe("");
  });

  it("matches a name regardless of case", () => {
    for (const query of ["alice at the beach", "ALICE at the beach", "aLiCe at the beach"]) {
      expect(parseQuery(query, ALICE).terms).toHaveLength(1);
    }
  });

  it("prefers the longest name, so Mary Jane beats Mary", () => {
    const both = vocab({ "p-mary": "Mary", "p-mj": "Mary Jane" });
    const parsed = parseQuery("Mary Jane at the beach", both);
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.terms[0].id).toBe("p-mj");
    // The failure this guards: "Jane" left in the residual, reading as scenery.
    expect(parsed.residual).toBe("at the beach");
  });

  it("still matches the shorter name when the longer one does not fit", () => {
    const both = vocab({ "p-mary": "Mary", "p-mj": "Mary Jane" });
    const parsed = parseQuery("Mary at the beach", both);
    expect(parsed.terms[0].id).toBe("p-mary");
    expect(parsed.residual).toBe("at the beach");
  });

  it("finds several people in one query", () => {
    const two = vocab({ "p-a": "Alice", "p-b": "Bob" });
    const parsed = parseQuery("Alice and Bob at the beach", two);
    expect(parsed.terms.map((t) => t.id)).toEqual(["p-a", "p-b"]);
    // "and" is not a name, so it stays — the dense stage is welcome to it.
    expect(parsed.residual).toBe("and at the beach");
  });

  it("matches a name anywhere in the query, not only at the start", () => {
    const parsed = parseQuery("beach photos of Alice", ALICE);
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.residual).toBe("beach photos of");
  });

  it("ignores unnamed clusters, which have no string a human could type", () => {
    const unnamed = vocab({ "p-1": "", "p-2": "   " });
    expect(parseQuery("someone at the beach", unnamed).terms).toEqual([]);
  });

  it("tolerates punctuation around a name", () => {
    const parsed = parseQuery("Alice, at the beach", ALICE);
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.terms[0].matched).toBe("Alice,");
  });

  it("collapses repeated whitespace without shifting spans", () => {
    const parsed = parseQuery("  Alice   at   the   beach ", ALICE);
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.residual).toBe("at the beach");
  });

  it("is deterministic when two clusters share a name", () => {
    // Indistinguishable from a query, so picking one arbitrarily is unavoidable —
    // but it must at least be the *same* one every time, or results flicker.
    const dupes = vocab({ "p-1": "Alice", "p-2": "Alice" });
    const first = parseQuery("Alice", dupes);
    const second = parseQuery("Alice", dupes);
    expect(first.terms[0].id).toBe(second.terms[0].id);
  });

  it("handles an empty query", () => {
    const parsed = parseQuery("", ALICE);
    expect(parsed.terms).toEqual([]);
    expect(parsed.residual).toBe("");
  });
});

describe("name collisions with common nouns", () => {
  // §5.2's motivating list. The parse *will* match these, which is correct — it
  // cannot know better — and is exactly why the interpretation must be removable.
  it.each(["Rose", "Daisy", "Iris", "Summer", "Mark", "Sunny", "Robin", "Jasmine"])(
    "matches %s as a person, since the query cannot say otherwise",
    (name) => {
      const parsed = parseQuery(`${name} at the beach`, vocab({ "p-x": name }));
      expect(parsed.terms).toHaveLength(1);
      expect(parsed.residual).toBe("at the beach");
    },
  );
});

describe("withoutTerms", () => {
  it("returns the dropped word to the residual rather than deleting it", () => {
    // The distinction that makes chips useful: the *interpretation* was wrong, not
    // the word. "rose at the beach" should become a search for the flower.
    const parsed = parseQuery("Rose at the beach", vocab({ "p-rose": "Rose" }));
    const dropped = withoutTerms(parsed, new Set([termKey(parsed.terms[0])]));
    expect(dropped.terms).toEqual([]);
    expect(dropped.residual).toBe("Rose at the beach");
  });

  it("keeps the other interpretations when one is dropped", () => {
    const two = vocab({ "p-a": "Alice", "p-b": "Bob" });
    const parsed = parseQuery("Alice and Bob at the beach", two);
    const dropped = withoutTerms(parsed, new Set(["person:p-b"]));
    expect(dropped.terms.map((t) => t.id)).toEqual(["p-a"]);
    expect(dropped.residual).toBe("and Bob at the beach");
  });

  it("is a no-op for a key that did not match anything", () => {
    const parsed = parseQuery("Alice at the beach", ALICE);
    expect(withoutTerms(parsed, new Set(["person:nobody"]))).toBe(parsed);
  });

  it("dropping every term leaves the whole query as the residual", () => {
    const parsed = parseQuery("Alice", ALICE);
    const dropped = withoutTerms(parsed, new Set([termKey(parsed.terms[0])]));
    expect(dropped.residual).toBe("Alice");
  });
});

describe("object classes", () => {
  const withObjects = (people: Record<string, string> = {}) => vocab(people, true);

  it("matches a class name", () => {
    const parsed = parseQuery("dog on the beach", withObjects());
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.terms[0]).toMatchObject({ kind: "object", id: "dog", count: null });
    expect(parsed.residual).toBe("on the beach");
  });

  it("does not match classes when nothing has been detected", () => {
    // Matching "dog" as a class against an empty object store converts a query the
    // dense stage could answer into a filter that matches nothing.
    const parsed = parseQuery("dog on the beach", vocab({}, false));
    expect(parsed.terms).toEqual([]);
    expect(parsed.residual).toBe("dog on the beach");
  });

  it("prefers the longer class, so 'hot dog' is not 'dog'", () => {
    // The plan's own longest-match example, and both are real COCO classes.
    const parsed = parseQuery("hot dog", withObjects());
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.terms[0].id).toBe("hot dog");
    expect(parsed.residual).toBe("");
  });

  it("prefers a person over a class at the same span", () => {
    // A name was typed by a human onto a cluster in *this* library, so it is the
    // stronger claim — and §5.2's chips make a wrong person reading recoverable,
    // where a name read as furniture would not be.
    const parsed = parseQuery("Rose", withObjects({ "p-rose": "Rose" }));
    expect(parsed.terms[0].kind).toBe("person");
  });

  it("reads a count before the class", () => {
    for (const [query, count] of [
      ["three dogs", 3],
      ["2 cats", 2],
      ["ten people", 10],
    ] as const) {
      const parsed = parseQuery(query, withObjects());
      expect(parsed.terms).toHaveLength(1);
      expect(parsed.terms[0].count).toBe(count);
      // The number must not survive into the residual, where it is a meaningless
      // token for the text tower.
      expect(parsed.residual).toBe("");
    }
  });

  it("treats an article as 'any', not as one", () => {
    // "a dog" means any dog. Reading it as exactly one would exclude every photo
    // with two, which is the opposite of what was asked.
    const parsed = parseQuery("a dog", withObjects());
    expect(parsed.terms[0].count).toBeNull();
  });

  it("keeps the count out of the chip key, so editing the number is the same chip", () => {
    const three = parseQuery("three dogs", withObjects());
    const four = parseQuery("four dogs", withObjects());
    expect(termKey(three.terms[0])).toBe(termKey(four.terms[0]));
  });

  it("finds a class and a person in one query", () => {
    const parsed = parseQuery("Alice with two dogs at the beach", withObjects({ "p-a": "Alice" }));
    expect(parsed.terms.map((t) => `${t.kind}:${t.id}`)).toEqual(["person:p-a", "object:dog"]);
    expect(parsed.terms[1].count).toBe(2);
    expect(parsed.residual).toBe("with at the beach");
  });

  it("returns a dropped class to the residual", () => {
    const parsed = parseQuery("three dogs", withObjects());
    const dropped = withoutTerms(parsed, new Set([termKey(parsed.terms[0])]));
    expect(dropped.terms).toEqual([]);
    // The count came in with the class, so it goes back out with it.
    expect(dropped.residual).toBe("three dogs");
  });
});
