/**
 * The camera roll, against a fake media store.
 *
 * What is decidable without a handset: the sort order, the field mapping, the
 * permission states, and what happens to one asset that cannot be read. All
 * four are things that look plausible in a screenshot and wrong in use — a grid
 * sorted the wrong way reads as the wrong library, not as a bug.
 *
 * What is not decidable here, and stays a device gap: whether Android actually
 * grants the permission, and whether a `content://` URI renders in an `Image`.
 */
import { describe, it, expect } from "vitest";
import {
  describeAccess,
  formatDuration,
  listRecentMedia,
  type AssetMetadataLike,
  type DeviceMediaModule,
  type MediaPermission,
} from "../src/media/device-library";

function asset(overrides: Partial<AssetMetadataLike> & { id: string }): AssetMetadataLike {
  return {
    filename: "IMG_0001.jpg",
    mediaType: "image",
    width: 4032,
    height: 3024,
    duration: null,
    creationTime: 1_700_000_000_000,
    modificationTime: 1_700_000_000_000,
    ...overrides,
  };
}

/** Records how the query was built, since the ordering is the thing under test. */
function fakeMedia(
  rows: AssetMetadataLike[],
  options: { uriFor?: (id: string) => Promise<string>; permission?: MediaPermission } = {},
) {
  const built: { orderBy?: { key: string; ascending?: boolean }; limit?: number } = {};
  const media: DeviceMediaModule = {
    getPermissions: async () =>
      options.permission ?? { granted: true, canAskAgain: true, accessPrivileges: "all" },
    requestPermissions: async () =>
      options.permission ?? { granted: true, canAskAgain: true, accessPrivileges: "all" },
    newQuery() {
      const query = {
        orderBy(sort: { key: string; ascending?: boolean }) {
          built.orderBy = sort;
          return query;
        },
        limit(count: number) {
          built.limit = count;
          return query;
        },
        exeForMetadata: async () => rows,
      };
      return query;
    },
    uriFor: options.uriFor ?? (async (id) => `file:///resolved/${id}`),
  };
  return { media, built };
}

describe("listing recent media", () => {
  it("asks for the newest first, up to the limit", async () => {
    // A camera roll opening on photos from years ago reads as the wrong
    // library rather than the wrong sort order.
    const { media, built } = fakeMedia([asset({ id: "content://1" })]);

    await listRecentMedia(media, { limit: 60 });

    expect(built.orderBy).toEqual({ key: "creationTime", ascending: false });
    expect(built.limit).toBe(60);
  });

  it("maps the media store's fields onto items", async () => {
    const { media } = fakeMedia([
      asset({
        id: "content://media/external/video/media/7",
        filename: "VID_0007.mp4",
        mediaType: "video",
        duration: 12_500,
        creationTime: 1_700_000_000_000,
      }),
    ]);

    expect(await listRecentMedia(media, { limit: 10 })).toEqual([
      {
        id: "content://media/external/video/media/7",
        uri: "content://media/external/video/media/7",
        filename: "VID_0007.mp4",
        kind: "video",
        width: 4032,
        height: 3024,
        durationMs: 12_500,
        createdAt: 1_700_000_000_000,
        modifiedAt: 1_700_000_000_000,
      },
    ]);
  });

  it("carries the modification time through, since import compares against it", async () => {
    // The alias staleness check has no other source: a `content://` URI resolves
    // to a `ContentProviderFile`, whose `lastModified()` is always null. Dropping
    // this field here would make an edited photo indistinguishable from an
    // untouched one, silently leaving a record's content hash describing bytes
    // that no longer exist.
    const { media } = fakeMedia([asset({ id: "content://5", modificationTime: null })]);
    expect(await listRecentMedia(media, { limit: 10 })).toMatchObject([{ modifiedAt: null }]);
  });

  it("keeps the nulls the media store admits to", async () => {
    // Android's media store does not always record dimensions. Substituting a
    // zero would be inventing a fact about someone's file.
    const { media } = fakeMedia([
      asset({ id: "content://9", width: null, height: null, creationTime: null, filename: null }),
    ]);

    expect(await listRecentMedia(media, { limit: 10 })).toMatchObject([
      { width: null, height: null, createdAt: null, filename: null },
    ]);
  });

  it("treats an unrecognised media type as unknown rather than dropping it", async () => {
    const { media } = fakeMedia([asset({ id: "content://3", mediaType: "pdf" })]);

    expect((await listRecentMedia(media, { limit: 10 }))[0].kind).toBe("unknown");
  });

  it("uses the id directly when it is already a URI", async () => {
    // The Android common case. Resolving each one would be a per-asset bridge
    // call for information already in hand.
    let resolves = 0;
    const { media } = fakeMedia([asset({ id: "content://media/external/images/media/12345" })], {
      uriFor: async (id) => {
        resolves += 1;
        return `file:///resolved/${id}`;
      },
    });

    const items = await listRecentMedia(media, { limit: 10 });

    expect(items[0].uri).toBe("content://media/external/images/media/12345");
    expect(resolves).toBe(0);
  });

  it("resolves an id that is not a URI", async () => {
    const { media } = fakeMedia([asset({ id: "12345" })]);

    expect((await listRecentMedia(media, { limit: 10 }))[0].uri).toBe("file:///resolved/12345");
  });

  it("drops one unreadable asset instead of emptying the grid", async () => {
    // Deleted between the query and the read, or on an unmounted volume. One
    // missing tile is a far better outcome than no photos at all.
    const { media } = fakeMedia([asset({ id: "1" }), asset({ id: "2" }), asset({ id: "3" })], {
      uriFor: async (id) => {
        if (id === "2") throw new Error("asset not found");
        return `file:///resolved/${id}`;
      },
    });

    expect((await listRecentMedia(media, { limit: 10 })).map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("returns nothing, rather than throwing, on an empty library", async () => {
    const { media } = fakeMedia([]);
    expect(await listRecentMedia(media, { limit: 10 })).toEqual([]);
  });
});

describe("describeAccess", () => {
  it("reads full access as granted", () => {
    expect(describeAccess({ granted: true, canAskAgain: true, accessPrivileges: "all" })).toBe(
      "granted",
    );
  });

  it("reads a partial share as limited, not as a denial", () => {
    // The user chose to share some of their library. That choice deserves a
    // working grid of what they shared, not a nag about the rest.
    expect(describeAccess({ granted: true, canAskAgain: true, accessPrivileges: "limited" })).toBe(
      "limited",
    );
  });

  it("separates a refusal that can be asked again from one that cannot", () => {
    // Different words on screen: one is answerable with a button, the other
    // only in system settings, and a prompt that does nothing is worse than a
    // sentence explaining why.
    expect(describeAccess({ granted: false, canAskAgain: true })).toBe("denied");
    expect(describeAccess({ granted: false, canAskAgain: false })).toBe("blocked");
  });

  it("does not need accessPrivileges to decide", () => {
    // Android below 14 omits it entirely.
    expect(describeAccess({ granted: true, canAskAgain: true })).toBe("granted");
  });
});

describe("formatDuration", () => {
  it("formats as m:ss with a padded second", () => {
    expect(formatDuration(12_500)).toBe("0:13");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(3_600_000)).toBe("60:00");
  });

  it("says 'video' rather than 0:00 when the store recorded no duration", () => {
    // A tile claiming a zero-length video describes a broken file. The file is
    // fine; the media store simply did not say.
    expect(formatDuration(null)).toBe("video");
  });
});
