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
  derivedKindOf,
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
  labels: [{ app_id: "photos", key: PHOTOS_LABEL_KEYS.rendition }],
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
        labels: [{ app_id: "someone-else", key: PHOTOS_LABEL_KEYS.rendition }],
      }),
    ).toBeNull();
  });
});

// `canThumbnail` and `findThumbnailFor` were the in-memory versions of these
// rules, for a caller holding an already-hydrated page. Both lost their last
// caller when the grid stopped listing renditions as records, and the rules
// they encoded survive in `precheckThumbnail`, which asks the server the same
// two questions with two indexed lookups instead of a page scan.

describe("isThumbnail", () => {
  it("is true only for Photos' thumbnail label", () => {
    expect(isThumbnail(thumbnailOf("T", "P"))).toBe(true);
    expect(isThumbnail(cropOf("C", "P"))).toBe(false);
    expect(isThumbnail(original("P"))).toBe(false);
  });
});
