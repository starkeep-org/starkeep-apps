/**
 * Tests for the coalescing URL batch loader: requests inside one flush window
 * become a single loadBatch call, in-flight ids are deduplicated, failed or
 * omitted ids become requestable again, and dispose drops pending work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUrlBatchLoader } from "../src/lib/url-batch-loader";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function urls(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("createUrlBatchLoader", () => {
  it("coalesces requests within the flush window into one batch call", async () => {
    const loadBatch = vi.fn().mockResolvedValue(urls({ a: "u-a", b: "u-b" }));
    const onLoaded = vi.fn();
    const loader = createUrlBatchLoader({ loadBatch, onLoaded, flushDelayMs: 50 });

    loader.request("a");
    loader.request("b");
    loader.request("a"); // duplicate within the window
    expect(loadBatch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(loadBatch).toHaveBeenCalledTimes(1);
    expect(loadBatch).toHaveBeenCalledWith(["a", "b"]);
    expect(onLoaded).toHaveBeenCalledWith(urls({ a: "u-a", b: "u-b" }));
  });

  it("does not re-request ids that are already in flight", async () => {
    let resolveBatch!: (value: Map<string, string>) => void;
    const loadBatch = vi.fn().mockReturnValue(new Promise((r) => (resolveBatch = r)));
    const onLoaded = vi.fn();
    const loader = createUrlBatchLoader({ loadBatch, onLoaded, flushDelayMs: 10 });

    loader.request("a");
    await vi.advanceTimersByTimeAsync(10); // flush; "a" now in flight
    expect(loadBatch).toHaveBeenCalledTimes(1);

    loader.request("a"); // in flight — must not schedule another flush
    await vi.advanceTimersByTimeAsync(50);
    expect(loadBatch).toHaveBeenCalledTimes(1);

    resolveBatch(urls({ a: "u-a" }));
    await vi.runAllTimersAsync();
    expect(onLoaded).toHaveBeenCalledWith(urls({ a: "u-a" }));
  });

  it("starts a new batch for requests made after a flush", async () => {
    const loadBatch = vi
      .fn()
      .mockResolvedValueOnce(urls({ a: "u-a" }))
      .mockResolvedValueOnce(urls({ b: "u-b" }));
    const onLoaded = vi.fn();
    const loader = createUrlBatchLoader({ loadBatch, onLoaded, flushDelayMs: 10 });

    loader.request("a");
    await vi.advanceTimersByTimeAsync(10);
    loader.request("b");
    await vi.advanceTimersByTimeAsync(10);

    expect(loadBatch).toHaveBeenNthCalledWith(1, ["a"]);
    expect(loadBatch).toHaveBeenNthCalledWith(2, ["b"]);
  });

  it("releases ids on batch failure so they can be requested again", async () => {
    const loadBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("throttled"))
      .mockResolvedValueOnce(urls({ a: "u-a" }));
    const onLoaded = vi.fn();
    const loader = createUrlBatchLoader({ loadBatch, onLoaded, flushDelayMs: 10 });

    loader.request("a");
    await vi.advanceTimersByTimeAsync(10);
    expect(onLoaded).not.toHaveBeenCalled();

    loader.request("a"); // retry after failure
    await vi.advanceTimersByTimeAsync(10);
    expect(loadBatch).toHaveBeenCalledTimes(2);
    expect(onLoaded).toHaveBeenCalledWith(urls({ a: "u-a" }));
  });

  it("releases ids the server omitted so they can be requested again", async () => {
    const loadBatch = vi
      .fn()
      .mockResolvedValueOnce(urls({ a: "u-a" })) // "gone" omitted
      .mockResolvedValueOnce(urls({}));
    const onLoaded = vi.fn();
    const loader = createUrlBatchLoader({ loadBatch, onLoaded, flushDelayMs: 10 });

    loader.request("a");
    loader.request("gone");
    await vi.advanceTimersByTimeAsync(10);

    loader.request("gone");
    await vi.advanceTimersByTimeAsync(10);
    expect(loadBatch).toHaveBeenNthCalledWith(2, ["gone"]);
  });

  it("does not call onLoaded for an empty result", async () => {
    const loadBatch = vi.fn().mockResolvedValue(urls({}));
    const onLoaded = vi.fn();
    const loader = createUrlBatchLoader({ loadBatch, onLoaded, flushDelayMs: 10 });

    loader.request("a");
    await vi.advanceTimersByTimeAsync(10);
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("dispose cancels the pending flush and suppresses late results", async () => {
    let resolveBatch!: (value: Map<string, string>) => void;
    const loadBatch = vi.fn().mockReturnValue(new Promise((r) => (resolveBatch = r)));
    const onLoaded = vi.fn();
    const loader = createUrlBatchLoader({ loadBatch, onLoaded, flushDelayMs: 10 });

    // Pending flush cancelled outright.
    loader.request("a");
    loader.dispose();
    await vi.advanceTimersByTimeAsync(50);
    expect(loadBatch).not.toHaveBeenCalled();

    // A batch already in flight at dispose time must not surface late.
    const loader2 = createUrlBatchLoader({ loadBatch, onLoaded, flushDelayMs: 10 });
    loader2.request("b");
    await vi.advanceTimersByTimeAsync(10);
    expect(loadBatch).toHaveBeenCalledTimes(1);
    loader2.dispose();
    resolveBatch(urls({ b: "u-b" }));
    await vi.runAllTimersAsync();
    expect(onLoaded).not.toHaveBeenCalled();

    // Requests after dispose are ignored.
    loader2.request("c");
    await vi.advanceTimersByTimeAsync(50);
    expect(loadBatch).toHaveBeenCalledTimes(1);
  });
});
