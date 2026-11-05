/**
 * The grid's selection as a pure function of clicks: a toggle, a shift-click
 * run from the anchor, and the photos that leave the shown list.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, extendTo, isSelecting, retainShown, toggle } from "@/photos-lib/selection";

const ORDER = ["a", "b", "c", "d", "e"];

describe("selection", () => {
  it("starts with a toggle and ends when the last tile is toggled off", () => {
    const one = toggle(EMPTY_SELECTION, "b");
    expect(isSelecting(one)).toBe(true);
    expect([...one.ids]).toEqual(["b"]);
    expect(toggle(one, "b")).toBe(EMPTY_SELECTION);
  });

  it("extends a run from the anchor in grid order, either direction", () => {
    const fromB = toggle(EMPTY_SELECTION, "b");
    expect([...extendTo(fromB, "d", ORDER).ids].sort()).toEqual(["b", "c", "d"]);
    const fromD = toggle(EMPTY_SELECTION, "d");
    const run = extendTo(fromD, "a", ORDER);
    expect([...run.ids].sort()).toEqual(["a", "b", "c", "d"]);
    expect(run.anchor).toBe("a");
  });

  it("keeps what was already selected when it extends", () => {
    const s = toggle(toggle(EMPTY_SELECTION, "e"), "a");
    expect([...extendTo(s, "b", ORDER).ids].sort()).toEqual(["a", "b", "e"]);
  });

  it("toggles alone when the anchor is no longer shown", () => {
    const s = toggle(EMPTY_SELECTION, "gone");
    expect([...extendTo(s, "c", ORDER).ids].sort()).toEqual(["c", "gone"]);
  });

  it("drops tiles that leave the shown list", () => {
    const s = extendTo(toggle(EMPTY_SELECTION, "a"), "c", ORDER);
    const kept = retainShown(s, new Set(["a", "b"]));
    expect([...kept.ids].sort()).toEqual(["a", "b"]);
    expect(kept.anchor).toBeNull();
    expect(retainShown(s, new Set(ORDER))).toBe(s);
    expect(retainShown(s, new Set())).toBe(EMPTY_SELECTION);
  });
});
