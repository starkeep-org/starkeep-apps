/**
 * The label rules both resize paths ask about.
 *
 * `/api/resize` (Next) and the cloud resize Lambda are line-for-line copies of
 * each other, and both used to answer these two questions inline from
 * `parent_id`. Both answers were wrong once crops existed, and neither copy had
 * a test — so the same bug had to be found and fixed twice. The rules now live
 * in photos-lib, and this is where they are pinned.
 */
import { describe, it, expect } from "vitest";
import {
  canThumbnail,
  derivedKindOf,
  findThumbnailFor,
  isThumbnail,
  PHOTOS_LABEL_KEYS,
} from "../src/photos-lib/labels";

type Row = {
  id: string;
  parent_id: string | null;
  labels?: Array<{ app_id: string; key: string }>;
};

const original = (id: string): Row => ({ id, parent_id: null, labels: [] });
const thumbnailOf = (id: string, parent: string): Row => ({
  id,
  parent_id: parent,
  labels: [{ app_id: "photos", key: PHOTOS_LABEL_KEYS.thumbnail }],
});
const cropOf = (id: string, parent: string): Row => ({
  id,
  parent_id: parent,
  labels: [{ app_id: "photos", key: PHOTOS_LABEL_KEYS.crop }],
});

describe("derivedKindOf", () => {
  it("distinguishes a thumbnail from a crop — both have a parent", () => {
    expect(derivedKindOf(thumbnailOf("T", "P"))).toBe("thumbnail");
    expect(derivedKindOf(cropOf("C", "P"))).toBe("crop");
  });

  it("is null for an original, for an unhydrated list, and for an unlabelled child", () => {
    expect(derivedKindOf(original("P"))).toBeNull();
    // Labels absent entirely — `?include=labels` is opt-in.
    expect(derivedKindOf({})).toBeNull();
    // The transient state between the record write and its label write.
    expect(derivedKindOf({ labels: [] })).toBeNull();
  });

  it("ignores another app's key of the same name", () => {
    expect(
      derivedKindOf({
        labels: [{ app_id: "someone-else", key: PHOTOS_LABEL_KEYS.thumbnail }],
      }),
    ).toBeNull();
  });
});

describe("canThumbnail", () => {
  it("refuses to thumbnail a thumbnail", () => {
    const records = [original("P"), thumbnailOf("T", "P")];
    expect(canThumbnail(records, "T")).toBe(false);
  });

  it("ALLOWS thumbnailing a crop", () => {
    // The bug: rejecting anything with a parent left every crop without a
    // thumbnail, and therefore invisible in a grid that renders thumbnails.
    const records = [original("P"), cropOf("C", "P")];
    expect(canThumbnail(records, "C")).toBe(true);
  });

  it("allows an original, and a target the list doesn't contain", () => {
    expect(canThumbnail([original("P")], "P")).toBe(true);
    // A page that didn't include the target is not evidence it is a thumbnail.
    expect(canThumbnail([original("P")], "UNSEEN")).toBe(true);
  });
});

describe("findThumbnailFor", () => {
  it("finds the existing thumbnail so a second resize is skipped", () => {
    const records = [original("P"), thumbnailOf("T", "P")];
    expect(findThumbnailFor(records, "P")?.id).toBe("T");
  });

  it("does NOT mistake a crop of the same photo for its thumbnail", () => {
    // Matching any child meant that cropping a photo silently suppressed its
    // thumbnail: the resize call returned "already done" and pointed at the
    // crop.
    const records = [original("P"), cropOf("C", "P")];
    expect(findThumbnailFor(records, "P")).toBeUndefined();
  });

  it("picks the thumbnail out of a mixed set of children", () => {
    const records = [original("P"), cropOf("C", "P"), thumbnailOf("T", "P")];
    expect(findThumbnailFor(records, "P")?.id).toBe("T");
  });

  it("ignores a thumbnail of a different photo", () => {
    const records = [original("P"), original("Q"), thumbnailOf("T", "Q")];
    expect(findThumbnailFor(records, "P")).toBeUndefined();
  });
});

describe("isThumbnail", () => {
  it("is true only for Photos' thumbnail label", () => {
    expect(isThumbnail(thumbnailOf("T", "P"))).toBe(true);
    expect(isThumbnail(cropOf("C", "P"))).toBe(false);
    expect(isThumbnail(original("P"))).toBe(false);
  });
});
