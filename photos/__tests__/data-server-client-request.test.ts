/**
 * Tests for the data-server-client transport behaviors added for the Lambda
 * throttling incident: 429/503 retry with jittered backoff in request(), and
 * the batched signed-URL fetch (getPhotoFileUrls) that collapses the gallery's
 * per-photo file-url fan-out into one POST per chunk.
 *
 * fetch is stubbed; timers are faked so backoff sleeps resolve instantly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveDataSource } from "../src/lib/data-client";
import {
  getPhotoFileUrl,
  getPhotoFileUrls,
  retryDelayMs,
  FILE_URL_BATCH_MAX,
} from "../src/lib/data-server-client";

vi.mock("../src/lib/data-client", () => ({
  resolveDataSource: vi.fn(),
}));

const SOURCE = { baseUrl: "http://ds", headers: {} as Record<string, string> };

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  (resolveDataSource as ReturnType<typeof vi.fn>).mockResolvedValue(SOURCE);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Run a request-driving promise to completion, flushing backoff timers. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  // Attach a catch first so a rejection during timer-flushing isn't unhandled.
  const guarded = promise.catch((err) => ({ __err: err as Error }));
  await vi.runAllTimersAsync();
  const result = await guarded;
  if (result && typeof result === "object" && "__err" in (result as object)) {
    throw (result as { __err: Error }).__err;
  }
  return result as T;
}

describe("request() retry on throttle statuses", () => {
  it("retries a 503 and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(503, { message: "Service Unavailable" }))
      .mockResolvedValueOnce(response(200, { url: "https://signed/u1" }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await settle(getPhotoFileUrl("r1"));
    expect(url).toBe("https://signed/u1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { message: "Too Many Requests" }))
      .mockResolvedValueOnce(response(200, { url: "https://signed/u2" }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await settle(getPhotoFileUrl("r2"));
    expect(url).toBe("https://signed/u2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 retries (4 attempts) and throws the final status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(503, { message: "Service Unavailable" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(settle(getPhotoFileUrl("r3"))).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-throttle failures (404, 500)", async () => {
    for (const status of [404, 500]) {
      const fetchMock = vi.fn().mockResolvedValue(response(status, { error: "nope" }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(settle(getPhotoFileUrl("r4"))).rejects.toThrow(new RegExp(String(status)));
      expect(fetchMock, `status ${status}`).toHaveBeenCalledTimes(1);
    }
  });

  it("waits the Retry-After duration when the server provides one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, {}, { "retry-after": "2" }))
      .mockResolvedValueOnce(response(200, { url: "https://signed/u5" }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = getPhotoFileUrl("r5").catch((err) => ({ __err: err as Error }));
    // Let the first attempt fail and the backoff timer get scheduled.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(result).toBe("https://signed/u5");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("retryDelayMs", () => {
  it("stays within the full-jitter envelope [0, base * 2^attempt] and grows per attempt", () => {
    const randomSpy = vi.spyOn(Math, "random");
    randomSpy.mockReturnValue(1); // upper edge
    expect(retryDelayMs(0)).toBe(300);
    expect(retryDelayMs(1)).toBe(600);
    expect(retryDelayMs(2)).toBe(1200);
    expect(retryDelayMs(10)).toBe(4000); // capped
    randomSpy.mockReturnValue(0); // lower edge
    expect(retryDelayMs(0)).toBe(0);
    expect(retryDelayMs(5)).toBe(0);
  });

  it("honors a numeric Retry-After (seconds), capped, ignoring garbage", () => {
    expect(retryDelayMs(0, "2")).toBe(2000);
    expect(retryDelayMs(0, "60")).toBe(4000); // capped
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    expect(retryDelayMs(0, "not-a-date-we-support")).toBe(300); // falls back to jitter
    randomSpy.mockRestore();
  });
});

describe("getPhotoFileUrls batching", () => {
  it("short-circuits on empty input without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getPhotoFileUrls([]);
    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts one deduplicated batch and maps ids to urls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(200, {
        urls: {
          a: { url: "https://signed/a", mimeType: "image/jpeg" },
          b: { url: "https://signed/b" },
        },
        expiresIn: 3600,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await settle(getPhotoFileUrls(["a", "b", "a", "missing"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://ds/data/records/file-urls");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["a", "b", "missing"] });
    expect(result.get("a")).toBe("https://signed/a");
    expect(result.get("b")).toBe("https://signed/b");
    // Ids the server omitted are simply absent.
    expect(result.has("missing")).toBe(false);
  });

  it("chunks past the batch max and merges the results", async () => {
    const ids = Array.from({ length: FILE_URL_BATCH_MAX + 5 }, (_, i) => `id-${i}`);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const { ids: chunk } = JSON.parse(init!.body as string) as { ids: string[] };
      return response(200, {
        urls: Object.fromEntries(chunk.map((id) => [id, { url: `https://signed/${id}` }])),
        expiresIn: 3600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await settle(getPhotoFileUrls(ids));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstChunk = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { ids: string[] };
    const secondChunk = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string) as { ids: string[] };
    expect(firstChunk.ids).toHaveLength(FILE_URL_BATCH_MAX);
    expect(secondChunk.ids).toHaveLength(5);
    expect(result.size).toBe(ids.length);
    expect(result.get("id-0")).toBe("https://signed/id-0");
    expect(result.get(`id-${FILE_URL_BATCH_MAX + 4}`)).toBe(`https://signed/id-${FILE_URL_BATCH_MAX + 4}`);
  });
});
