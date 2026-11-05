/**
 * Album membership in the photo list, after a change this page made. The
 * library delta follows record changes rather than label changes, so the
 * reducer is what shows a photo joining or leaving an album at once.
 */
import { describe, expect, it } from "vitest";
import { photoReducer } from "../src/photos-ui/context/photo-context";
import type { AppImage } from "../src/photos-lib/client";

const image = (id: string, albumIds: string[] = []) => ({ id, albumIds }) as unknown as AppImage;
const state = (images: AppImage[]) => ({ images, nextCursor: null, loading: false, loaded: true, policies: null });

describe("SET_ALBUM_MEMBERSHIP", () => {
  it("adds and removes the album on the named photos only", () => {
    const added = photoReducer(state([image("a"), image("b", ["x"]), image("c")]), {
      type: "SET_ALBUM_MEMBERSHIP",
      ids: ["a", "b"],
      albumId: "x",
      member: true,
    });
    expect(added.images.map((i) => i.albumIds)).toEqual([["x"], ["x"], []]);
    const removed = photoReducer(added, { type: "SET_ALBUM_MEMBERSHIP", ids: ["b"], albumId: "x", member: false });
    expect(removed.images.map((i) => i.albumIds)).toEqual([["x"], [], []]);
  });
});

describe("FORGET_ALBUM", () => {
  it("drops a deleted album from every photo", () => {
    const next = photoReducer(state([image("a", ["x", "y"]), image("b", ["y"])]), { type: "FORGET_ALBUM", albumId: "y" });
    expect(next.images.map((i) => i.albumIds)).toEqual([["x"], []]);
  });
});
