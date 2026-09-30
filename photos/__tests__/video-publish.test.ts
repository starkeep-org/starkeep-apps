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

function makeSignedFetch(overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    for (const [prefix, make] of Object.entries(overrides)) {
      if (path.startsWith(prefix)) return make();
    }
    if (path === "/files/presign") {
      return new Response(JSON.stringify({ url: "https://upload.example/put" }), { status: 200 });
    }
    if (path === "/data/records") {
      return new Response(JSON.stringify({ record: { id: "child-1" } }), { status: 200 });
    }
    if (path.startsWith("/data/records?")) {
      return new Response(JSON.stringify({ records: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ tagged: true, refusals: [] }), { status: 200 });
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
  // The poster is what the grid paints. Registered as video it would be hidden
  // from every image-granted app — a library with holes where the clips are.
  it("registers a poster as an image", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash", "key");
    const create = calls.find((c) => c.path === "/data/records")!;
    expect(create.body.type).toBe("image/jpeg");
  });

  it("registers a transcode as a VP9 WebM stand-in at the canonical bitrate", async () => {
    await publishVideoRendition(
      signedFetch, { ...parent, sourceFidelity: 12_000 },
      rendition({ sizeClass: "video-1080p", kind: "transcode", type: "video", contentType: "video/webm", durationMs: 12_000 }),
      "hash", "key",
    );
    const create = calls.find((c) => c.path === "/data/records")!;
    expect(create.body.type).toBe("video/webm");
    expect(create.body.standIn).toEqual({ role: "canonical", fidelity: 4800 });
    expect(create.body.parentFidelity).toBe(12_000);
    // The platform's columns describe a stand-in: no label, no metadata row.
    expect(create.body.labels).toBeUndefined();
    expect(create.body.metadata).toBeUndefined();
  });

  it("puts a low-bitrate video's canonical stand-in at the video's own bitrate", async () => {
    await publishVideoRendition(
      signedFetch, { ...parent, sourceFidelity: 3000 },
      rendition({ sizeClass: "video-1080p", kind: "transcode", type: "video", contentType: "video/webm" }),
      "hash", "key",
    );
    expect(calls.find((c) => c.path === "/data/records")!.body.standIn).toEqual({
      role: "canonical",
      fidelity: 3000,
    });
  });

  // A poster is a derived record: it carries its dimensions with its create,
  // in the table matching its type, so no sync round ships a poster the grid
  // cannot size.
  it("registers a poster's dimensions with the poster, in the image table's shape", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash", "key");
    const create = calls.find((c) => c.path === "/data/records")!;
    expect(create.body.metadata).toMatchObject({ width: 225, height: 400 });
    expect(create.body.standIn).toBeUndefined();
    expect(calls.some((c) => c.path.endsWith("/metadata"))).toBe(false);
  });

  it("includes duration for moving derived records only", async () => {
    await publishVideoRendition(
      signedFetch, parent,
      rendition({ sizeClass: "video-skim", kind: "skim", type: "video", contentType: "video/mp4", durationMs: 2_000 }),
      "hash", "key",
    );
    expect(calls.find((c) => c.path === "/data/records")!.body.metadata).toMatchObject({ duration_ms: 2_000 });
  });

  it("labels a derived record so the library can leave it out", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash", "key");
    expect(calls.find((c) => c.path === "/data/records")!.body.labels).toEqual([
      { key: "derived", value: "video-poster-thumb" },
    ]);
  });

  // A poster named `.mov` is a JPEG that half the world refuses to open.
  it("names the file for what was produced, not for the source", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash", "key");
    expect(calls.find((c) => c.path === "/data/records")!.body.fileName).toBe(
      "video-poster-thumb_IMG_0042.jpg",
    );
  });

  it("declares every rung instant, since renditions are what a cold library is read from", async () => {
    await publishVideoRendition(signedFetch, parent, rendition(), "hash", "key");
    expect(calls.find((c) => c.path === "/files/presign")!.body.intent).toBe("instant");
  });

  it("does not report publication success when the registration fails", async () => {
    const failing = makeSignedFetch({
      "/data/records": () => new Response("nope", { status: 500 }),
    });
    await expect(
      publishVideoRendition(failing, parent, rendition(), "hash", "key"),
    ).rejects.toMatchObject({ stage: "register", sizeClass: "video-poster-thumb" });
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
    keyFor: async () => ({ contentHash: "h", objectStorageKey: "k" }),
    ...over,
  });

  it("writes facts before publishing renditions", async () => {
    await deriveAndPublishVideo("/clip.mov", parent, deps());
    const factsAt = calls.findIndex((c) => c.path === "/data/records/rec-1/metadata");
    const firstUpload = calls.findIndex((c) => c.path === "/files/presign");
    // Interrupted after the facts, the record is a correctly-shaped placeholder.
    // Interrupted the other way round, the layout cannot place it at all.
    expect(factsAt).toBeGreaterThanOrEqual(0);
    expect(factsAt).toBeLessThan(firstUpload);
  });

  it("publishes every applicable rung, the canonical stand-in included", async () => {
    const result = await deriveAndPublishVideo("/clip.mov", parent, deps());
    expect(result.published.map((p) => p.sizeClass).sort()).toEqual(
      ["video-1080p", "video-720p", "video-poster-720p", "video-poster-thumb", "video-skim"].sort(),
    );
  });

  it("reports the video's bitrate in kbps as the original's fidelity", async () => {
    await deriveAndPublishVideo("/clip.mov", parent, deps());
    expect(calls.find((c) => c.path === "/data/records/rec-1/fidelity")!.body).toEqual({ fidelity: 12_000 });
    const transcodes = calls.filter((c) => c.path === "/data/records" && c.body.standIn);
    expect(transcodes.map((c) => c.body.standIn)).toEqual([
      { role: "smaller", fidelity: 2000 },
      { role: "canonical", fidelity: 4800 },
    ]);
  });

  function planeHolding(standIns: Array<[string, number]>, derived: string[]) {
    return vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      if (path.startsWith("/data/records?")) {
        const decoded = decodeURIComponent(path);
        if (decoded.includes("stand_in_role")) {
          return new Response(JSON.stringify({
            records: standIns.map(([role, fidelity]) => ({ type: "video/webm", stand_in_role: role, fidelity })),
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          records: derived.map((value) => ({ labels: [{ app_id: "photos", key: "derived", value }] })),
        }), { status: 200 });
      }
      if (path === "/files/presign") {
        return new Response(JSON.stringify({ url: "https://upload.example/put" }), { status: 200 });
      }
      return new Response(JSON.stringify({ record: { id: "child-1" } }), { status: 200 });
    });
  }

  it("does not re-encode or republish rungs that already exist, wherever they were made", async () => {
    signedFetch = planeHolding(
      [["smaller", 2000], ["canonical", 4800]],
      ["video-poster-thumb", "video-poster-720p", "video-skim"],
    );
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

  it("derives what a caller says is missing, even when the server lists it", async () => {
    signedFetch = planeHolding(
      [["smaller", 2000], ["canonical", 4800]],
      ["video-poster-thumb", "video-poster-720p", "video-skim"],
    );
    const extractPoster = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      width: 225,
      height: 400,
    }));
    const result = await deriveAndPublishVideo(
      "/clip.mov",
      parent,
      deps({ availableRenditionClasses: [], tools: tools({ extractPoster }) }),
    );
    expect(extractPoster).toHaveBeenCalled();
    expect(result.published.length).toBeGreaterThan(0);
  });

  it("reuses a canonical stand-in another node made rather than failing", async () => {
    const base = makeSignedFetch();
    signedFetch = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as { standIn?: { role: string } }) : {};
      if (path === "/data/records" && body.standIn?.role === "canonical") {
        return new Response(JSON.stringify({ error: "StandInExists", existing: "made-elsewhere" }), { status: 409 });
      }
      return base(path, init);
    }) as typeof signedFetch;
    const result = await deriveAndPublishVideo("/clip.mov", parent, deps());
    expect(result.failed).toEqual([]);
    expect(result.published.find((p) => p.sizeClass === "video-1080p")).toMatchObject({
      recordId: "made-elsewhere",
      reused: true,
    });
  });

  it("never asks for archiving: the platform decides once the canonical stand-in is in the cloud", async () => {
    const result = await deriveAndPublishVideo("/clip.mov", parent, deps());
    expect(result.ladderComplete).toBe(true);
    expect(calls.some((c) => c.path.includes("archive"))).toBe(false);
  });

  it("never claims completeness when a rung failed", async () => {
    const result = await deriveAndPublishVideo(
      "/clip.mov",
      parent,
      deps({ tools: tools({ transcode: async () => { throw new Error("encoder died"); } }) }),
    );
    expect(result.ladderComplete).toBe(false);
    expect(result.failed.map((f) => f.sizeClass)).toEqual(expect.arrayContaining(["video-720p", "video-1080p"]));
  });

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
