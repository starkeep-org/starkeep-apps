/**
 * Choosing what to paint and what to play for a video record.
 *
 * The ambiguity these exist to resolve is specific and easy to miss: a video's
 * children include a **poster and a transcode at the same long edge** —
 * `video-poster-720p` and `video-720p` are both 1280 — and the server resolves
 * by size, breaking ties on id. Asking for 1280 can therefore hand back either
 * one. Painting a tile from whatever came back eventually puts an MP4 in an
 * `<img>`; playing it puts a JPEG in a `<video>`. Neither fails loudly.
 */
import { describe, it, expect } from "vitest";
import { posterSrc, playbackSrc, isVideoRecord } from "../src/photos-lib/variant-src";
import type { AppImage } from "../src/photos-lib/types/app-image";

const image = (variants: AppImage["variants"], mimeType = "video/mp4"): AppImage =>
  ({ id: "rec-1", mimeType, variants } as unknown as AppImage);

/** Both 1280 — the collision the type field exists to break. */
const AMBIGUOUS: AppImage["variants"] = {
  "400": { url: "/poster-thumb.jpg", width: 225, height: 400, type: "image/jpeg" },
  "1280": { url: "/poster-720.jpg", width: 720, height: 1280, type: "image/jpeg" },
  "1281": { url: "/video-720.mp4", width: 720, height: 1280, type: "video/mp4" },
};

describe("telling a video record from a photo", () => {
  it("reads the record's own type", () => {
    expect(isVideoRecord({ mimeType: "video/mp4" })).toBe(true);
    expect(isVideoRecord({ mimeType: "video/quicktime" })).toBe(true);
    expect(isVideoRecord({ mimeType: "image/jpeg" })).toBe(false);
  });
});

describe("what the grid paints", () => {
  it("never returns a moving rendition, even at a matching size", () => {
    const poster = posterSrc(image(AMBIGUOUS), 1280);
    expect(poster!.url).not.toContain(".mp4");
    expect(poster!.url).toBe("/poster-720.jpg");
  });

  it("falls back to a smaller poster rather than reaching for the video", () => {
    const onlySmallPoster: AppImage["variants"] = {
      "400": { url: "/poster-thumb.jpg", width: 225, height: 400, type: "image/jpeg" },
      "1281": { url: "/video-720.mp4", width: 720, height: 1280, type: "video/mp4" },
    };
    const poster = posterSrc(image(onlySmallPoster), 1280);
    expect(poster!.url).toBe("/poster-thumb.jpg");
    expect(poster!.isBelowTarget).toBe(true);
  });
});

describe("what the player plays", () => {
  it("never returns a still, even at a matching size", () => {
    const playback = playbackSrc(image(AMBIGUOUS), 1280);
    expect(playback!.url).toBe("/video-720.mp4");
  });

  // A clip whose transcode has not been derived is not broken, it is not ready.
  // Falling back to the original would be worse than useless: it is the large
  // file the transcode exists to avoid streaming.
  it("reports nothing playable rather than offering a still", () => {
    const postersOnly: AppImage["variants"] = {
      "400": { url: "/poster-thumb.jpg", width: 225, height: 400, type: "image/jpeg" },
    };
    expect(playbackSrc(image(postersOnly), 1280)).toBeNull();
  });

  it("reports nothing playable when the record has no renditions at all", () => {
    expect(playbackSrc(image({}), 1280)).toBeNull();
    expect(posterSrc(image({}), 1280)).toBeNull();
  });
});

describe("a server that does not send the variant type", () => {
  // Keeps a still-only library working against an older server, and errs in the
  // safe direction: assuming video instead would blank the grid for everyone.
  it("treats untyped variants as stills", () => {
    const untyped: AppImage["variants"] = {
      "1280": { url: "/medium.jpg", width: 960, height: 1280 },
    };
    expect(posterSrc(image(untyped, "image/jpeg"), 1280)!.url).toBe("/medium.jpg");
    expect(playbackSrc(image(untyped), 1280)).toBeNull();
  });
});
