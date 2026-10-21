/** Removing records deleted elsewhere from the grid, and closing the viewer on one. */
import { describe, expect, it } from "vitest";
import { photoReducer } from "../src/photos-ui/context/photo-context";
import type { AppImage } from "../src/photos-lib/client";

const image = (id: string) => ({ id }) as AppImage;
const state = (selectedId: string | null) => ({
  images: [image("a"), image("b"), image("c")],
  selectedId,
  nextCursor: null,
  loading: false,
  policies: null,
});

describe("REMOVE_IMAGES", () => {
  it("drops the named records and keeps the rest in order", () => {
    const next = photoReducer(state(null), { type: "REMOVE_IMAGES", ids: ["b", "zzz"] });
    expect(next.images.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("closes the viewer when it shows a removed record, and only then", () => {
    expect(photoReducer(state("b"), { type: "REMOVE_IMAGES", ids: ["b"] }).selectedId).toBeNull();
    expect(photoReducer(state("a"), { type: "REMOVE_IMAGES", ids: ["b"] }).selectedId).toBe("a");
  });

  it("returns the same state when nothing it names is in the grid", () => {
    const before = state("a");
    expect(photoReducer(before, { type: "REMOVE_IMAGES", ids: ["zzz"] })).toBe(before);
  });
});
