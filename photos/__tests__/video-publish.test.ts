/**
 * Publishing a video's facts and renditions.
 *
 * The derivation tests prove the bytes are right; these prove the right
 * requests get made about them. That is a separate failure surface — a
 * correctly derived poster registered under the wrong type, or written to the
 * wrong metadata table, is invisible in the bytes and fatal in the library.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  publishVideoFacts,
  publishVideoRendition,
} from "../src/photos-lib/video/publish-video";
import { deriveAndPublishVideo } from "../src/photos-lib/video/derive-and-publish";
import type { VideoFacts } from "../src/photos-lib/video/probe";
import type { DerivedVideoRendition } from "../src/photos-lib/video/derive-video-ladder";
import type { VideoTools } from "../src/photos-lib/video/video-tools";

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown>;
}

let calls: Call[];
let signedFetch: ReturnType<typeof makeSignedFetch>;

/**
 * A data server that speaks the app-private plane.
 *
 * `existingRungs` is what the rendition table already holds for `rec-1`, which
 * is what first-writer-wins reads before it uploads anything.
 */
function makeSignedFetch(
  overrides: Record<string, () => Response> = {},
  existingRungs: string[] = [],
) {
  return vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({
      path,
      method,
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    // A key with a space is method-scoped ("POST /app-data/db/renditions"),
    // which is what lets a test fail the row *write* without also failing the
    // first-writer-wins *read* of the same path.
    for (const [key, make] of Object.entries(overrides)) {
      const [wantMethod, prefix] = key.includes(" ") ? key.split(" ") : [null, key];
      if (path.startsWith(prefix!) && (wantMethod === null || wantMethod === method)) {
        return make();
      }
    }
    if (path.startsWith("/app-data/db/renditions") && method === "GET") {
      return new Response(
        JSON.stringify({
          rows: existingRungs.map((size_class) => ({
            parent_record_id: "rec-1",
            size_class,
            sub_key: `renditions/rec-1/${size_class}/hh.mp4`,
            content_hash: "hh",
            width: 1280,
            height: 720,
            size_bytes: 1000,
            content_type: "video/mp4",
          })),
          page_token: null,
        }),
        { status: 200 },
      );
    }
    if (path === "/app-data/files/presign") {
      return new Response(JSON.stringify({ url: "https://upload.example/put" }), { status: 200 });
    }
    return new Response(JSON.stringify({ tagged: true, refusals: [], ok: true }), { status: 200 });
  });
}

const facts: VideoFacts = {
  width: 1080, height: 1920, durationMs: 12_500, frameRate: 29.97,
  videoCodec: "hevc", audioCodec: "aac", bitrate: 12_000_000,
  capturedAt: "2026-03-04T10:00:00.000Z", rotation: 90,
};

const rendition = (over: Partial<DerivedVideoRendition> = {}): DerivedVideoRendition => ({
  sizeClass: "video-poster-thumb",
  bytes: new Uint8Array([1, 2, 3]),
  contentType: "image/jpeg",
  kind: "poster",
  width: 225,
  height: 400,
  type: "image",
  ...over,
});

const parent = { id: "rec-1", originalFilename: "IMG_0042.mov" };

beforeEach(() => {
  calls = [];
  signedFetch = makeSignedFetch();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});

const bodyOf = (predicate: (c: Call) => boolean) => calls.find(predicate)?.body ?? {};

describe("writing container facts", () => {
  it("writes them to the video metadata table", async () => {
    await publishVideoFacts(signedFetch, "rec-1", facts);
    const call = calls.find((c) => c.path === "/data/records/rec-1/metadata")!;
    expect(call.body.typeId).toBe("video");
    expect(call.body.metadata).toMatchObject({
      width: 1080,
      height: 1920,
      duration_ms: 12_500,
      video_codec: "hevc",
      captured_at: "2026-03-04T10:00:00.000Z",
    });
  });

  // A column left absent means "not known". A column written as null asserts
  // the container was asked and said nothing — a different, usually false claim.
  it("omits fields the container did not provide rather than writing null", async () => {
    await publishVideoFacts(signedFetch, "rec-1", {
      ...facts,
      audioCodec: null,
      bitrate: null,
      capturedAt: null,
    });
    const metadata = bodyOf((c) => c.path.endsWith("/metadata")).metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("audio_codec");
    expect(metadata).not.toHaveProperty("bitrate");
    expect(metadata).not.toHaveProperty("captured_at");
    expect(metadata).toHaveProperty("width");
  });

  // Not best-effort: dimensions and duration are what the grid lays a tile out
  // with, and a video record without them cannot be reasoned about at all.
  it("throws when the write fails", async () => {
    const failing = makeSignedFetch({
      "/data/records/rec-1/metadata": () => new Response("nope", { status: 500 }),
    });
    await expect(publishVideoFacts(failing, "rec-1", facts)).rejects.toThrow();
  });
});

describe("publishing a rendition", () => {
  // Nothing about a rung reaches the shared plane any more. A poster used to be
  // registered as an `image` record so image-granted apps could see it; no app
  // sees any rung now, which is the decision this project made.
  it("writes no shared record at all", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash");
    expect(calls.some((c) => c.path === "/data/records")).toBe(false);
  });

  it("puts the bytes under the ladder's own key, hash and all", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash");
    expect(calls.find((c) => c.path === "/app-data/files/presign")!.body.subKey).toBe(
      "renditions/rec-1/video-poster-thumb/hash.jpg",
    );
  });

  it("names a transcode by its own type, not the poster's", async () => {
    await publishVideoRendition(
      signedFetch, parent,
      rendition({ sizeClass: "video-720p", kind: "transcode", type: "video", contentType: "video/mp4", durationMs: 12_000 }),
      "hash",
    );
    expect(calls.find((c) => c.path === "/app-data/files/presign")!.body.subKey).toBe(
      "renditions/rec-1/video-720p/hash.mp4",
    );
  });

  // Dimensions are columns of the row now, written with it rather than after
  // it, so the window where a rung existed and its size did not is gone.
  it("writes the rung's dimensions as part of its row", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash");
    const row = calls.find(
      (c) => c.path === "/app-data/db/renditions" && c.method === "POST",
    )!.body.row as Record<string, unknown>;
    expect(row).toMatchObject({
      parent_record_id: "rec-1",
      size_class: "video-poster-thumb",
      width: 225,
      height: 400,
      content_type: "image/jpeg",
    });
  });

  // A poster named `.mov` is a JPEG that half the world refuses to open.
  it("names the file for what was produced, not for the source", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash");
    expect(
      calls.find((c) => c.path.endsWith("/record"))!.body.originalFilename,
    ).toBe("video-poster-thumb_IMG_0042.jpg");
  });

  it("does not report publication success when the row cannot be written", async () => {
    const failing = makeSignedFetch({
      "POST /app-data/db/renditions": () => new Response("nope", { status: 500 }),
    });
    await expect(
      publishVideoRendition(failing, parent, rendition(), "hash"),
    ).rejects.toMatchObject({ stage: "row", sizeClass: "video-poster-thumb" });
  });

  // Object keys stop moving once a rung exists, which is what lets a published
  // URL keep its meaning under a reader holding it.
  it("leaves a rung another node already published alone", async () => {
    const withExisting = makeSignedFetch({}, ["video-poster-thumb"]);
    const result = await publishVideoRendition(withExisting, parent, rendition(), "hash");
    expect(result.alreadyPublished).toBe(true);
    expect(calls.some((c) => c.path === "/app-data/files/presign")).toBe(false);
  });
});

describe("the ingest path", () => {
  const tools = (over: Partial<VideoTools> = {}): VideoTools => ({
    available: async () => true,
    probe: async () => facts,
    extractPoster: async () => ({ bytes: new Uint8Array([1]), width: 225, height: 400 }),
    skim: async () => ({ bytes: new Uint8Array([2]), width: 270, height: 480, durationMs: 2000 }),
    transcode: async () => ({ bytes: new Uint8Array([3]), width: 720, height: 1280, durationMs: 12500 }),
    ...over,
  });

  const deps = (over: Partial<Parameters<typeof deriveAndPublishVideo>[2]> = {}) => ({
    signedFetch,
    tools: tools(),
    hashOf: async () => "h",
    ...over,
  });

  it("writes facts before publishing renditions", async () => {
    await deriveAndPublishVideo("/clip.mov", parent, deps());
    const factsAt = calls.findIndex((c) => c.path === "/data/records/rec-1/metadata");
    const firstUpload = calls.findIndex((c) => c.path === "/app-data/files/presign");
    // Interrupted after the facts, the record is a correctly-shaped placeholder.
    // Interrupted the other way round, the layout cannot place it at all.
    expect(factsAt).toBeGreaterThanOrEqual(0);
    expect(factsAt).toBeLessThan(firstUpload);
  });

  it("publishes every applicable rung", async () => {
    const result = await deriveAndPublishVideo("/clip.mov", parent, deps());
    expect(result.published.map((p) => p.sizeClass).sort()).toEqual(
      ["video-720p", "video-poster-720p", "video-poster-thumb", "video-skim"].sort(),
    );
  });

  it("does not re-encode or republish rungs that already exist", async () => {
    signedFetch = makeSignedFetch({}, [
      "video-poster-thumb",
      "video-poster-720p",
      "video-skim",
      "video-720p",
    ]);
    const extractPoster = vi.fn();
    const skim = vi.fn();
    const transcode = vi.fn();
    const result = await deriveAndPublishVideo(
      "/clip.mov",
      parent,
      deps({ tools: tools({ extractPoster, skim, transcode }) }),
    );
    expect(result.published).toEqual([]);
    expect(extractPoster).not.toHaveBeenCalled();
    expect(skim).not.toHaveBeenCalled();
    expect(transcode).not.toHaveBeenCalled();
    expect(result.ladderComplete).toBe(true);
  });

  it("re-derives a rung whose row is here and whose bytes are not", async () => {
    signedFetch = makeSignedFetch({}, [
      "video-poster-thumb",
      "video-poster-720p",
      "video-skim",
      "video-720p",
    ]);
    const extractPoster = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      width: 225,
      height: 400,
    }));

    const result = await deriveAndPublishVideo(
      "/clip.mov",
      parent,
      deps({
        availableRenditionClasses: [],
        tools: tools({ extractPoster }),
      }),
    );

    expect(extractPoster).toHaveBeenCalled();
    expect(result.published.length).toBeGreaterThan(0);
  });

  it("keeps the archive gate closed when a rung's row cannot be written", async () => {
    signedFetch = makeSignedFetch({
      "POST /app-data/db/renditions": () => new Response("nope", { status: 500 }),
    });
    const result = await deriveAndPublishVideo("/clip.mov", parent, deps());
    expect(result.failed.length).toBeGreaterThan(0);
    expect(result.ladderComplete).toBe(false);
    expect(result.archiveTagged).toBe(false);
    expect(calls.some((call) => call.path.endsWith("/archive-gate"))).toBe(false);
  });

  it("asserts the archive gate once the ladder is complete", async () => {
    const result = await deriveAndPublishVideo("/clip.mov", parent, deps());
    expect(result.ladderComplete).toBe(true);
    expect(calls.some((c) => c.path === "/data/records/rec-1/archive-gate")).toBe(true);
  });

  // Claiming completeness with a rung missing is how an original gets frozen
  // behind a 48-hour thaw while the thing that would be read instead does not
  // exist.
  it("never claims completeness when a rung failed", async () => {
    const result = await deriveAndPublishVideo(
      "/clip.mov",
      parent,
      deps({ tools: tools({ transcode: async () => { throw new Error("encoder died"); } }) }),
    );
    expect(result.ladderComplete).toBe(false);
    expect(result.archiveTagged).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/archive-gate"))).toBe(false);
    expect(result.failed.map((f) => f.sizeClass)).toContain("video-720p");
  });

  // A clip with a poster and no transcode is one the grid can still show.
  it("keeps what succeeded when a rung fails", async () => {
    const result = await deriveAndPublishVideo(
      "/clip.mov",
      parent,
      deps({ tools: tools({ transcode: async () => { throw new Error("encoder died"); } }) }),
    );
    expect(result.published.map((p) => p.sizeClass)).toContain("video-poster-thumb");
  });

  it("fails terminally when ffmpeg is absent, rather than reporting an empty ladder", async () => {
    // Reported as success-with-nothing, a missing ffmpeg would let the import
    // mark the file done and never come back to it.
    await expect(
      deriveAndPublishVideo("/clip.mov", parent, deps({ tools: tools({ available: async () => false }) })),
    ).rejects.toThrow(/ffmpeg/i);
  });
});
