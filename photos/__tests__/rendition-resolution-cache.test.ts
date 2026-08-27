import { describe, expect, it, vi } from "vitest";
import {
  RenditionResolutionCache,
  resolutionKey,
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
});
