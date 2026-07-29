import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  faceCropUrl,
  fetchImageFaces,
  fetchPeople,
  fetchVisionStatus,
  mutatePeople,
  startVisionScan,
  stopVisionScan,
  updateVisionConfig,
  VISION_UNAVAILABLE,
} from "@/lib/vision-client";

/**
 * The browser-side client.
 *
 * Two things here are behaviour rather than plumbing. **501 is not an error** —
 * a Photos serving from a remote data server is a normal state the UI renders by
 * hiding the feature, not a failure it reports; treating it as one would put a
 * red banner on every cloud install. And **every path is prefixed** — the cloud
 * mount is `/apps/photos`, and a root-absolute request that skips it leaves the
 * app entirely, which is the bug `client-base-path.test.ts` exists to catch
 * statically.
 */

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const notImplemented = () =>
  new Response(JSON.stringify({ error: "not on-device" }), { status: 501 });

const lastUrl = () => String(fetchMock.mock.calls.at(-1)![0]);
const lastInit = () => fetchMock.mock.calls.at(-1)![1] as RequestInit | undefined;

/** Every reader and writer, so the 501 branch can be asserted uniformly. */
const ALL_CALLS: Array<[string, () => Promise<unknown>]> = [
  ["fetchVisionStatus", () => fetchVisionStatus()],
  ["updateVisionConfig", () => updateVisionConfig({ faces: { enabled: true } })],
  ["startVisionScan", () => startVisionScan()],
  ["stopVisionScan", () => stopVisionScan()],
  ["fetchImageFaces", () => fetchImageFaces("rec-1")],
  ["fetchPeople", () => fetchPeople()],
  ["mutatePeople", () => mutatePeople({ action: "recluster" })],
];

describe("the 501 sentinel", () => {
  it.each(ALL_CALLS)("%s returns VISION_UNAVAILABLE rather than throwing", async (_n, call) => {
    fetchMock.mockResolvedValue(notImplemented());
    await expect(call()).resolves.toBe(VISION_UNAVAILABLE);
  });

  it("is distinguishable from a legitimately empty result", async () => {
    // "No faces here" and "this build cannot look" are different answers, and
    // only one of them means the user should run a scan.
    fetchMock.mockResolvedValue(ok({ processed: true, faces: [] }));
    const result = await fetchImageFaces("rec-1");
    expect(result).not.toBe(VISION_UNAVAILABLE);
    expect(result).toMatchObject({ processed: true, faces: [] });
  });
});

describe("path prefixing", () => {
  it.each(ALL_CALLS)("%s requests a path under /api/vision", async (_n, call) => {
    fetchMock.mockResolvedValue(ok({}));
    await call();
    expect(lastUrl().startsWith("/api/vision/")).toBe(true);
  });

  it("encodes a record id that needs it", async () => {
    fetchMock.mockResolvedValue(ok({ processed: false, faces: [] }));
    await fetchImageFaces("id with/slash");
    expect(lastUrl()).toContain(encodeURIComponent("id with/slash"));
    expect(lastUrl()).not.toContain("id with/slash");
  });

  it("prefixes every path when the app is mounted under a basePath", async () => {
    // The behavioural counterpart to `client-base-path.test.ts`, which catches
    // an unwrapped call statically. This one proves the wrapping *works*: in
    // cloud the app is mounted at /apps/photos, and an unprefixed request is
    // answered by the API Gateway's default 404 rather than by Photos.
    //
    // `BASE_PATH` is read at module load, so the modules are re-imported with
    // the env set rather than mutated in place.
    const saved = process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;
    process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH = "/apps/photos";
    vi.resetModules();
    try {
      const client = await import("@/lib/vision-client");
      const calls: Array<[string, () => Promise<unknown>]> = [
        ["status", () => client.fetchVisionStatus()],
        ["config", () => client.updateVisionConfig({ faces: { enabled: true } })],
        ["scan", () => client.startVisionScan()],
        ["faces", () => client.fetchImageFaces("rec-1")],
        ["people", () => client.fetchPeople()],
      ];
      for (const [, call] of calls) {
        fetchMock.mockResolvedValueOnce(ok({}));
        await call();
        expect(lastUrl().startsWith("/apps/photos/api/vision/")).toBe(true);
      }
      expect(client.faceCropUrl({ recordId: "r", faceIndex: 0, score: 1 })).toBe(
        "/apps/photos/api/vision/face-crop/r?face=0",
      );
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH;
      else process.env.NEXT_PUBLIC_STARKEEP_APP_BASE_PATH = saved;
      vi.resetModules();
    }
  });
});

describe("errors", () => {
  it("unwraps the server's error field", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "face detection is off" }), { status: 409 }),
    );
    await expect(startVisionScan()).rejects.toThrow("face detection is off");
  });

  it("falls back to the status line for a non-JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>gateway</html>", { status: 502 }));
    await expect(fetchPeople()).rejects.toThrow(/502/);
  });

  it("propagates a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchVisionStatus()).rejects.toThrow(/Failed to fetch/);
  });
});

describe("writers", () => {
  it("sends config patches as JSON on PUT", async () => {
    fetchMock.mockResolvedValue(ok({ config: {} }));
    await updateVisionConfig({ faces: { threshold: 0.6 } });
    const init = lastInit()!;
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ faces: { threshold: 0.6 } });
  });

  it("distinguishes starting a scan from stopping one", async () => {
    // A fresh Response per call: a body can only be read once, and reusing one
    // across both calls fails on the second for a reason unrelated to the test.
    fetchMock.mockImplementation(() => Promise.resolve(ok({ scan: {} })));
    await startVisionScan();
    expect(JSON.parse(String(lastInit()!.body))).toEqual({ action: "start" });
    await stopVisionScan();
    expect(JSON.parse(String(lastInit()!.body))).toEqual({ action: "stop" });
  });

  it("passes a people action through unchanged", async () => {
    fetchMock.mockResolvedValue(ok({ people: [] }));
    await mutatePeople({ action: "merge", targetId: "a", sourceIds: ["b", "c"] });
    expect(JSON.parse(String(lastInit()!.body))).toEqual({
      action: "merge",
      targetId: "a",
      sourceIds: ["b", "c"],
    });
  });
});

describe("faceCropUrl", () => {
  it("addresses a single face by record and index", () => {
    const url = faceCropUrl({ recordId: "rec-1", faceIndex: 3, score: 0.9 });
    expect(url).toBe("/api/vision/face-crop/rec-1?face=3");
  });

  it("encodes the record id", () => {
    const url = faceCropUrl({ recordId: "a/b c", faceIndex: 0, score: 0.9 });
    expect(url).toContain(encodeURIComponent("a/b c"));
  });

  it("keeps index 0 in the URL rather than omitting it", () => {
    // The route defaults a missing `face` to 0, but relying on that would make
    // the cover crop and an explicit first face different URLs — and therefore
    // separate cache entries for identical bytes.
    expect(faceCropUrl({ recordId: "r", faceIndex: 0, score: 1 })).toContain("face=0");
  });
});
