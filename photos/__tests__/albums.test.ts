/**
 * Album membership as labels, and the album rows Photos keeps beside them.
 *
 * The rules pinned here are the ones the proposal sets: a label value names
 * an album by its random id and nothing else; only an original belongs to an
 * album; and a deleted or malformed row is no album.
 */
import { describe, expect, it } from "vitest";
import {
  albumIdsOf,
  albumsFromRows,
  chunk,
  coverOf,
  isAlbumId,
  newAlbumId,
  normalizeAlbumTitle,
} from "@/photos-lib/albums";

const ID = "4de58a3c4d2a33014de58a3c4d2a3301";
const OTHER = "0123456789abcdef0123456789abcdef";

describe("album ids", () => {
  it("are 128 random bits as lowercase hex", () => {
    const id = newAlbumId();
    expect(isAlbumId(id)).toBe(true);
    expect(newAlbumId()).not.toBe(id);
    expect(newAlbumId((b) => b.fill(255))).toBe("f".repeat(32));
  });

  it("are the whole value: no slug, no name, no upper case", () => {
    expect(isAlbumId(ID)).toBe(true);
    expect(isAlbumId(`${ID}-summer-vacation-2026`)).toBe(false);
    expect(isAlbumId("Summer")).toBe(false);
    expect(isAlbumId(ID.toUpperCase())).toBe(false);
    expect(isAlbumId(undefined)).toBe(false);
  });
});

describe("albumIdsOf", () => {
  it("reads Photos' album labels, once per album, ignoring any value that is not a bare id", () => {
    expect(
      albumIdsOf({
        labels: [
          { app_id: "photos", key: "album", value: ID },
          { app_id: "photos", key: "album", value: `${ID}-slug` },
          { app_id: "photos", key: "album", value: OTHER },
          { app_id: "photos", key: "faces", value: ID },
          { app_id: "slideshow", key: "album", value: OTHER },
        ],
      }),
    ).toEqual([ID, OTHER]);
  });

  it("gives a child record no albums, whatever it carries", () => {
    expect(
      albumIdsOf({ parent_id: "orig", labels: [{ app_id: "photos", key: "album", value: ID }] }),
    ).toEqual([]);
  });
});

describe("albumsFromRows", () => {
  it("keeps live, well-formed rows, newest first", () => {
    const albums = albumsFromRows([
      { album_id: ID, title: " Summer ", cover_record_id: "rec-1", created_at_ms: 10, deleted: false },
      { album_id: OTHER, title: "Winter", cover_record_id: null, created_at_ms: "20", deleted: 0 },
      { album_id: "f".repeat(32), title: "Gone", created_at_ms: 30, deleted: true },
      { album_id: "not-an-id", title: "Bad", created_at_ms: 40, deleted: false },
      { album_id: "e".repeat(32), title: "   ", created_at_ms: 50, deleted: false },
    ]);
    expect(albums).toEqual([
      { id: OTHER, title: "Winter", coverRecordId: null, createdAtMs: 20 },
      { id: ID, title: "Summer", coverRecordId: "rec-1", createdAtMs: 10 },
    ]);
  });
});

describe("titles, covers and batches", () => {
  it("bounds a title", () => {
    expect(normalizeAlbumTitle("  Trip ")).toBe("Trip");
    expect(normalizeAlbumTitle("")).toBeNull();
    expect(normalizeAlbumTitle("x".repeat(201))).toBeNull();
    expect(normalizeAlbumTitle(3)).toBeNull();
  });

  it("uses the chosen cover while it is a member, else the first member", () => {
    const album = { id: ID, title: "T", coverRecordId: "b", createdAtMs: 0 };
    expect(coverOf(album, [{ id: "a" }, { id: "b" }])?.id).toBe("b");
    expect(coverOf(album, [{ id: "a" }])?.id).toBe("a");
    expect(coverOf(album, [])).toBeNull();
  });

  it("splits membership changes into requests", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([])).toEqual([]);
  });
});
