/**
 * The vocabulary three surfaces share for Photos' rendition table.
 *
 * The desktop writes rows over HTTP, the cloud writes them over HTTP and the
 * handset writes them straight into SQLite. What they cannot disagree about is
 * the key a rung's bytes land under and the shape of the row that names them —
 * a disagreement there is bytes one node can write and another can never find.
 */
import { describe, expect, it } from "vitest";
import {
  parentOfRenditionSubKey,
  renditionCandidate,
  renditionExtension,
  renditionFileName,
  renditionSubKey,
  RENDITION_SUBKEY_PREFIX,
  type RenditionRow,
} from "../src";

const row: RenditionRow = {
  parent_record_id: "rec-1",
  size_class: "image-medium",
  sub_key: "renditions/rec-1/image-medium/abcd.avif",
  content_hash: "abcd",
  width: 1280,
  height: 960,
  size_bytes: 40_000,
  content_type: "image/avif",
};

describe("where a rung's bytes go", () => {
  it("names the parent, the rung and the bytes, in that order", () => {
    expect(renditionSubKey("rec-1", "image-medium", "abcd", "image/avif")).toBe(
      "renditions/rec-1/image-medium/abcd.avif",
    );
  });

  // The hash is in the key so a published URL never changes meaning. A key
  // built from parent and rung alone would let two nodes write different bytes
  // under one name, and the loser of that race would silently replace what a
  // reader already had.
  it("gives two encodings of one rung two keys", () => {
    const a = renditionSubKey("rec-1", "image-medium", "aaaa", "image/avif");
    const b = renditionSubKey("rec-1", "image-medium", "bbbb", "image/avif");
    expect(a).not.toBe(b);
  });

  it("sits under the prefix the reaper walks", () => {
    expect(renditionSubKey("rec-1", "image-thumb", "aa", "image/avif")).toContain(
      RENDITION_SUBKEY_PREFIX,
    );
  });

  it("reads the parent back out, and declines for anything else", () => {
    expect(parentOfRenditionSubKey(row.sub_key)).toBe("rec-1");
    expect(parentOfRenditionSubKey("cover")).toBeNull();
    expect(parentOfRenditionSubKey("renditions/")).toBeNull();
  });

  it("names a file by what was produced, never by the source's container", () => {
    expect(renditionExtension("image/jpeg")).toBe("jpg");
    expect(renditionExtension("video/mp4")).toBe("mp4");
    // An honest refusal to guess beats a name that lies about a container.
    expect(renditionExtension("application/x-unknown")).toBe("bin");
    expect(renditionFileName("IMG_0042.mov", "video-poster-thumb", "image/jpeg")).toBe(
      "video-poster-thumb_IMG_0042.jpg",
    );
    expect(renditionFileName("photo.jpg", "image-medium")).toBe("image-medium_photo.jpg");
  });
});

describe("a row as the resolver sees it", () => {
  it("measures the long edge from the stored dimensions", () => {
    expect(renditionCandidate(row).longEdge).toBe(1280);
    expect(renditionCandidate({ ...row, width: 100, height: 400 }).longEdge).toBe(400);
  });

  // The id reaches the browser, and the sub-key names the rung. Clients ask in
  // pixels; a rung's name is an implementation detail of this ladder.
  it("identifies a rung by its content hash, not by its key", () => {
    const candidate = renditionCandidate(row, "https://files.invalid/x");
    expect(candidate.id).toBe("abcd");
    expect(JSON.stringify(candidate)).not.toContain("image-medium");
    expect(candidate.url).toBe("https://files.invalid/x");
  });

  it("omits the url when there is none rather than carrying an empty one", () => {
    expect(renditionCandidate(row)).not.toHaveProperty("url");
  });
});
