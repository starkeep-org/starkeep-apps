import { describe, expect, it } from "vitest";
import { resolveVideo } from "../src/routes/photos/library";
import type { HydratedRendition } from "../src/photos-lib/renditions/store";

/**
 * A rung as Photos' own table holds it.
 *
 * `id` in the assertions below is the content hash, which is what the decision
 * carries in place of a child record's id: stable across nodes, and unlike the
 * sub-key it does not name the rung.
 */
function candidate(
  id: string,
  size_class: string,
  long_edge: number,
  availableHere = true,
): HydratedRendition {
  const video = size_class === "video-720p" || size_class === "video-1080p";
  return {
    parent_record_id: "video-1",
    size_class,
    sub_key: id,
    content_hash: id,
    content_type: video ? "video/mp4" : "image/jpeg",
    width: long_edge,
    height: Math.round(long_edge * 0.5625),
    size_bytes: 1000,
    availableHere,
    url: `https://files.invalid/${id}`,
  };
}

describe("local video rendition resolution", () => {
  it("keeps poster and playback candidates separate at the same long edge", () => {
    const result = resolveVideo([
      candidate("poster", "video-poster-720p", 1280),
      candidate("playback", "video-720p", 1280),
    ], [1280], false);
    expect(result["1280"]?.poster?.id).toBe("poster");
    expect(result["1280"]?.playback?.id).toBe("playback");
  });

  it("prefers the smallest larger local playback rendition", () => {
    const result = resolveVideo([
      candidate("small", "video-720p", 640),
      candidate("near", "video-720p", 1280),
      candidate("far", "video-1080p", 1920),
    ], [1000], false);
    expect(result["1000"]?.playback?.id).toBe("near");
  });

  it("falls back to the largest smaller local playback rendition", () => {
    const result = resolveVideo([
      candidate("tiny", "video-720p", 400),
      candidate("best", "video-720p", 720),
    ], [1280], false);
    expect(result["1280"]?.playback?.id).toBe("best");
  });

  it("never uses a nonresident candidate as a local fallback", () => {
    const result = resolveVideo([
      candidate("remote", "video-1080p", 1920, false),
    ], [1280], false);
    expect(result["1280"]?.playback).toBeUndefined();
  });
});
