import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RenditionResolutionCache,
  resolutionKey,
  RETRY_MAX_MS,
  RETRY_START_MS,
} from "../src/lib/rendition-resolution-client";

const policies = {
  still: { kind: "still" as const, version: "still-v1", targetLongEdges: [128, 400, 1280] },
  video: { kind: "video" as const, version: "video-v1", targetLongEdges: [400, 1280] },
};

function ready(recordId: string, target: number, id = `${recordId}-rendition`) {
  return {
    recordId,
    status: "resolved" as const,
    mediaKind: "still" as const,
    policyVersion: policies.still.version,
    canonicalTargetLongEdge: target,
    decision: {
      ideal: {
        id,
        available: true,
        longEdge: target,
        width: target,
        height: Math.round(target * 0.75),
        url: `https://example.test/${id}`,
      },
    },
  };
}

function waiting(recordId: string, target: number) {
  return {
    recordId,
    status: "resolved" as const,
    mediaKind: "still" as const,
    policyVersion: policies.still.version,
    canonicalTargetLongEdge: target,
    decision: { ideal: { available: false, longEdge: target, state: "awaiting-upload" as const } },
  };
}

describe("RenditionResolutionCache", () => {
  it("deduplicates canonical keys and coalesces records into one batch", async () => {
    const send = vi.fn(async (_requests: unknown[]) => ({ policies, results: [ready("a", 400), ready("b", 400)] }));
    const cache = new RenditionResolutionCache(policies, send);
    expect(cache.request("a", "still", 200, 400)).toBe(cache.request("a", "still", 300, 400));
    cache.request("b", "still", 250, 400);
    await cache.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toHaveLength(2);
    expect(cache.get(resolutionKey("a", "still-v1", 400))?.status).toBe("ready");
  });

  it("rekeys a stale policy response to the server's current target", async () => {
    const current = {
      ...policies,
      still: { kind: "still" as const, version: "still-v2", targetLongEdges: [128, 512, 1280] },
    };
    const cache = new RenditionResolutionCache(policies, async () => ({
      policies: current,
      results: [{ ...ready("a", 400), policyVersion: "still-v2", canonicalTargetLongEdge: 512 }],
    }));
    cache.request("a", "still", 300, 400);
    await cache.flush();
    expect(cache.get(resolutionKey("a", "still-v1", 400))).toBeUndefined();
    expect(cache.get(resolutionKey("a", "still-v2", 512))?.status).toBe("ready");
  });

  it("keeps a still-valid URL when the stable rendition identity is unchanged", async () => {
    let call = 0;
    const cache = new RenditionResolutionCache(policies, async () => {
      call++;
      const result = ready("a", 400, "stable-id");
      result.decision.ideal.url = `https://example.test/signature-${call}`;
      Object.assign(result.decision.ideal, {
        urlLifetime: { kind: "expires", expires_at: new Date(Date.now() + 120_000).toISOString() },
      });
      return { policies, results: [result] };
    });
    cache.request("a", "still", 300, 400);
    await cache.flush();
    const key = resolutionKey("a", "still-v1", 400);
    const first = (cache.get(key)!.decision as { ideal: { url: string } }).ideal.url;
    cache.request("a", "still", 300, 400);
    await cache.flush();
    expect((cache.get(key)!.decision as { ideal: { url: string } }).ideal.url).toBe(first);
  });

  it("refreshes pending entries and removes records that left the library", async () => {
    const send = vi.fn(async () => ({
      policies,
      results: [{
        recordId: "a",
        status: "resolved" as const,
        mediaKind: "still" as const,
        policyVersion: "still-v1",
        canonicalTargetLongEdge: 400,
        decision: { ideal: { available: false, longEdge: 400, state: "pending" as const } },
      }],
    }));
    const cache = new RenditionResolutionCache(policies, send);
    cache.request("a", "still", 300, 400);
    await cache.flush();
    cache.subscribe(resolutionKey("a", "still-v1", 400), () => {});
    cache.refreshPending();
    await cache.flush();
    expect(send).toHaveBeenCalledTimes(2);
    cache.retainRecords(new Set());
    expect(cache.get(resolutionKey("a", "still-v1", 400))).toBeUndefined();
  });

  it("asks again for a video until it has both a poster and playback", async () => {
    const poster = { id: "p", url: "https://example.test/p", width: 1280, height: 720, type: "image/jpeg" };
    const playback = { id: "v", url: "https://example.test/v", width: 1280, height: 720, type: "video/webm" };
    const decisions = [{}, { poster }, { poster, playback }];
    const send = vi.fn(async () => ({
      policies,
      results: [{
        recordId: "v1",
        status: "resolved" as const,
        mediaKind: "video" as const,
        policyVersion: "video-v1",
        canonicalTargetLongEdge: 1280,
        decision: decisions[send.mock.calls.length - 1]!,
      }],
    }));
    const cache = new RenditionResolutionCache(policies, send);
    const key = resolutionKey("v1", "video-v1", 1280);
    cache.request("v1", "video", 1138, 1280);
    await cache.flush();
    cache.subscribe(key, () => {});
    expect(cache.get(key)?.status).toBe("pending");

    cache.refreshPending();
    await cache.flush();
    expect(cache.get(key)).toMatchObject({ status: "pending", decision: { poster: { id: "p" } } });

    cache.refreshPending();
    await cache.flush();
    expect(cache.get(key)?.status).toBe("ready");
    cache.refreshPending();
    expect(send).toHaveBeenCalledTimes(3);
  });
});

/**
 * Nothing tells a browser when a phone's upload lands, so the cache asks again
 * on its own timer about the entries on screen that are still waiting.
 */
describe("RenditionResolutionCache retry timer", () => {
  type Request = { recordId: string };
  /** The flush the timer's re-queue schedules, after its own delay. */
  const FLUSH_MS = 12;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance to just before `delay` fires, then past it and its flush. */
  async function expectRetryAfter(send: ReturnType<typeof vi.fn>, delay: number) {
    const before = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(send).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1 + FLUSH_MS);
    expect(send).toHaveBeenCalledTimes(before + 1);
  }

  it("asks again about an entry awaiting upload, doubling the wait up to the cap", async () => {
    const send = vi.fn(async (_requests: Request[]) => ({ policies, results: [waiting("a", 400)] }));
    const cache = new RenditionResolutionCache(policies, send);
    const key = cache.request("a", "still", 300, 400)!;
    await cache.flush();
    cache.subscribe(key, () => {});
    expect(cache.get(key)?.status).toBe("pending");

    let delay = RETRY_START_MS;
    while (delay < RETRY_MAX_MS) {
      await expectRetryAfter(send, delay);
      delay *= 2;
    }
    await expectRetryAfter(send, RETRY_MAX_MS);
    await expectRetryAfter(send, RETRY_MAX_MS);
    cache.dispose();
  });

  it("starts the wait over when an entry that was waiting arrives", async () => {
    const send = vi.fn(async (requests: Request[]) => ({
      policies,
      results: requests.map((r) =>
        r.recordId === "b" && send.mock.calls.length >= 4 ? ready("b", 400) : waiting(r.recordId, 400),
      ),
    }));
    const cache = new RenditionResolutionCache(policies, send);
    const a = cache.request("a", "still", 300, 400)!;
    const b = cache.request("b", "still", 300, 400)!;
    await cache.flush();
    cache.subscribe(a, () => {});
    cache.subscribe(b, () => {});

    await expectRetryAfter(send, RETRY_START_MS);
    await expectRetryAfter(send, RETRY_START_MS * 2);
    // The fourth answer brings b's bytes. A phone uploads file after file, so
    // the next ask comes soon rather than after the grown wait.
    await expectRetryAfter(send, RETRY_START_MS * 4);
    expect(cache.get(b)?.status).toBe("ready");
    await expectRetryAfter(send, RETRY_START_MS);
    cache.dispose();
  });

  it("asks nothing about a waiting entry no tile is showing", async () => {
    const send = vi.fn(async (_requests: Request[]) => ({ policies, results: [waiting("a", 400)] }));
    const cache = new RenditionResolutionCache(policies, send);
    cache.request("a", "still", 300, 400);
    await cache.flush();
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it("stops asking once disposed", async () => {
    const send = vi.fn(async (_requests: Request[]) => ({ policies, results: [waiting("a", 400)] }));
    const cache = new RenditionResolutionCache(policies, send);
    const key = cache.request("a", "still", 300, 400)!;
    await cache.flush();
    cache.subscribe(key, () => {});
    cache.dispose();
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks again after a request fails, at the same backoff", async () => {
    const send = vi.fn((_requests: Request[]) =>
      Promise.reject<{ policies: typeof policies; results: never[] }>(new Error("network down")),
    );
    const cache = new RenditionResolutionCache(policies, send);
    const key = cache.request("a", "still", 300, 400)!;
    await cache.flush();
    cache.subscribe(key, () => {});
    expect(cache.get(key)).toMatchObject({ status: "failed", error: "network down" });

    await expectRetryAfter(send, RETRY_START_MS);
    await expectRetryAfter(send, RETRY_START_MS * 2);
    expect(cache.get(key)?.status).toBe("failed");
    cache.dispose();
  });

  it("starts the wait over when a failed request recovers", async () => {
    const send = vi.fn(async (requests: Request[]) => {
      if (send.mock.calls.length <= 3) throw new Error("network down");
      return { policies, results: requests.map((r) => r.recordId === "b" ? ready("b", 400) : waiting(r.recordId, 400)) };
    });
    const cache = new RenditionResolutionCache(policies, send);
    const a = cache.request("a", "still", 300, 400)!;
    const b = cache.request("b", "still", 300, 400)!;
    await cache.flush();
    cache.subscribe(a, () => {});
    cache.subscribe(b, () => {});

    await expectRetryAfter(send, RETRY_START_MS);
    await expectRetryAfter(send, RETRY_START_MS * 2);
    // The network is back: b resolves and a goes on waiting for its upload.
    await expectRetryAfter(send, RETRY_START_MS * 4);
    expect(cache.get(b)?.status).toBe("ready");
    expect(cache.get(a)?.status).toBe("pending");
    await expectRetryAfter(send, RETRY_START_MS);
    cache.dispose();
  });

  it("drops a URL that failed to load and resolves the entry afresh", async () => {
    const send = vi.fn(async (_requests: Request[]) => {
      const result = ready("a", 400, "stable-id");
      result.decision.ideal.url = `https://example.test/signature-${send.mock.calls.length}`;
      // Still valid for hours, so only the failure report stops the cache
      // from keeping it.
      Object.assign(result.decision.ideal, {
        urlLifetime: { kind: "expires", expires_at: new Date(Date.now() + 7_200_000).toISOString() },
      });
      return { policies, results: [result] };
    });
    const cache = new RenditionResolutionCache(policies, send);
    const key = cache.request("a", "still", 300, 400)!;
    await cache.flush();
    cache.subscribe(key, () => {});
    const idealUrl = () => (cache.get(key)!.decision as { ideal: { url?: string } }).ideal.url;
    expect(idealUrl()).toBe("https://example.test/signature-1");

    cache.reportLoadFailure(key, "https://example.test/signature-1");
    expect(cache.get(key)?.status).toBe("pending");
    expect(idealUrl()).toBeUndefined();

    await expectRetryAfter(send, RETRY_START_MS);
    expect(cache.get(key)?.status).toBe("ready");
    expect(idealUrl()).toBe("https://example.test/signature-2");
    cache.dispose();
  });

  it("ignores a failure report about a URL the entry no longer holds", async () => {
    const send = vi.fn(async (_requests: Request[]) => ({ policies, results: [ready("a", 400)] }));
    const cache = new RenditionResolutionCache(policies, send);
    const key = cache.request("a", "still", 300, 400)!;
    await cache.flush();
    cache.subscribe(key, () => {});
    cache.reportLoadFailure(key, "https://example.test/replaced-long-ago");
    expect(cache.get(key)?.status).toBe("ready");
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(send).toHaveBeenCalledTimes(1);
    cache.dispose();
  });
});
