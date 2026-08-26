import { describe, expect, it, vi } from "vitest";
import { createRefreshCoalescer } from "../src/lib/refresh-coalescer";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("refresh coalescing", () => {
  it("serializes an event burst and retains exactly one trailing refresh", async () => {
    const first = deferred();
    const second = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const request = createRefreshCoalescer(refresh);

    const completion = request();
    void request();
    void request();
    expect(refresh).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);

    second.resolve();
    await completion;
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("starts a new refresh after the prior burst has drained", async () => {
    const refresh = vi.fn(async () => {});
    const request = createRefreshCoalescer(refresh);

    await request();
    await request();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
