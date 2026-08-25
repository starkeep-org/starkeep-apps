import { describe, expect, it } from "vitest";
import { resolveVideo } from "../app/api/photos/library/route";

type Candidate = NonNullable<Parameters<typeof resolveVideo>[0]["variant_candidates"]>[number];

function candidate(
  id: string,
  label_value: string,
  long_edge: number,
  available_here = true,
): Candidate {
  const video = label_value === "video-720p" || label_value === "video-1080p";
  return {
    id,
    type: video ? "video/mp4" : "image/jpeg",
    label_value,
    available_here,
    width: long_edge,
    height: Math.round(long_edge * 0.5625),
    long_edge,
    url: `https://files.invalid/${id}`,
  };
}

function record(candidates: Candidate[]) {
  return { id: "video-1", mime_type: "video/mp4", variant_candidates: candidates };
}

describe("local video rendition resolution", () => {
  it("keeps poster and playback candidates separate at the same long edge", () => {
    const result = resolveVideo(record([
      candidate("poster", "video-poster-720p", 1280),
      candidate("playback", "video-720p", 1280),
    ]), [1280], false);
    expect(result["1280"]?.poster?.id).toBe("poster");
    expect(result["1280"]?.playback?.id).toBe("playback");
  });

  it("prefers the smallest larger local playback rendition", () => {
    const result = resolveVideo(record([
      candidate("small", "video-720p", 640),
      candidate("near", "video-720p", 1280),
      candidate("far", "video-1080p", 1920),
    ]), [1000], false);
    expect(result["1000"]?.playback?.id).toBe("near");
  });

  it("falls back to the largest smaller local playback rendition", () => {
    const result = resolveVideo(record([
      candidate("tiny", "video-720p", 400),
      candidate("best", "video-720p", 720),
    ]), [1280], false);
    expect(result["1280"]?.playback?.id).toBe("best");
  });

  it("never uses a nonresident candidate as a local fallback", () => {
    const result = resolveVideo(record([
      candidate("remote", "video-1080p", 1920, false),
    ]), [1280], false);
    expect(result["1280"]?.playback).toBeUndefined();
  });
});
