// @vitest-environment jsdom
/**
 * The video player, given a source the browser may not decode.
 *
 * On a desktop that holds the original, the original is the playback source
 * until a transcode exists. Pixel clips are HEVC, which some browsers cannot
 * decode; the element then fires `error`, and the clip must read as "not ready
 * here" — the poster and "Video data is syncing…" — rather than as a dead player.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VideoPlayer } from "../src/photos-ui/components/viewer/video-player";
import type { AppImage } from "../src/photos-lib";

const image = { id: "video-1", originalFilename: "PXL_1.mp4" } as unknown as AppImage;
const entry = (id: string, url: string) => ({ id, url, width: 1920, height: 1080, type: "video/mp4" });

afterEach(cleanup);

describe("VideoPlayer", () => {
  it("plays the resolved source", () => {
    render(
      <VideoPlayer
        image={image}
        targetLongEdge={1280}
        decision={{ playback: entry("orig", "http://local/orig.mp4") }}
        onToggleInfo={vi.fn()}
      />,
    );
    expect(screen.getByTestId("video-player").getAttribute("src")).toBe("http://local/orig.mp4");
  });

  it("falls back to the poster and the syncing note when the browser cannot decode it", () => {
    render(
      <VideoPlayer
        image={image}
        targetLongEdge={1280}
        decision={{
          playback: entry("orig", "http://local/orig.mp4"),
          poster: { ...entry("poster", "http://local/poster.jpg"), type: "image/jpeg" },
        }}
        onToggleInfo={vi.fn()}
      />,
    );
    fireEvent.error(screen.getByTestId("video-player"));
    expect(screen.queryByTestId("video-player")).toBeNull();
    expect(screen.getByTestId("video-not-ready")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("src")).toBe("http://local/poster.jpg");
  });

  it("tries a new source after one failed", () => {
    const { rerender } = render(
      <VideoPlayer
        image={image}
        targetLongEdge={1280}
        decision={{ playback: entry("orig", "http://local/orig.mp4") }}
        onToggleInfo={vi.fn()}
      />,
    );
    fireEvent.error(screen.getByTestId("video-player"));
    rerender(
      <VideoPlayer
        image={image}
        targetLongEdge={1280}
        decision={{ playback: entry("t", "http://local/video-720p.webm") }}
        onToggleInfo={vi.fn()}
      />,
    );
    expect(screen.getByTestId("video-player").getAttribute("src")).toBe("http://local/video-720p.webm");
  });
});
