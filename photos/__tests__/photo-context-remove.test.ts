/** Removing records deleted elsewhere from the grid. */
import { describe, expect, it } from "vitest";
import { photoReducer } from "../src/photos-ui/context/photo-context";
import type { AppImage } from "../src/photos-lib/client";

const image = (id: string) => ({ id }) as AppImage;
const state = () => ({
  images: [image("a"), image("b"), image("c")],
  nextCursor: null,
  loading: false,
  loaded: true,
  policies: null,
});

describe("REMOVE_IMAGES", () => {
  it("drops the named records and keeps the rest in order", () => {
    const next = photoReducer(state(), { type: "REMOVE_IMAGES", ids: ["b", "zzz"] });
    expect(next.images.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("returns the same state when nothing it names is in the grid", () => {
    const before = state();
    expect(photoReducer(before, { type: "REMOVE_IMAGES", ids: ["zzz"] })).toBe(before);
  });
});
