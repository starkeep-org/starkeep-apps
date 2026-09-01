/**
 * What bounds the network while a background window is open.
 *
 * React Native's `fetch` carries no timeouts of its own, so this wrapper is the
 * only thing standing between a stalled socket and a window that holds the
 * day's whole execution allowance open. All of it is decidable here: the guard
 * takes its clock and its timers, and the fetch it wraps is a fake.
 */
import { describe, it, expect } from "vitest";
import type { Timers } from "../src/deadline";
import { createWindowGuard } from "../src/work/window-guard";

function manualTimers(): Timers & { fire(): void; armed(): number } {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimeout(handler: () => void): unknown {
      const handle = next++;
      pending.set(handle, handler);
      return handle;
    },
    clearTimeout(handle: unknown): void {
      pending.delete(handle as number);
    },
    fire(): void {
      for (const [handle, handler] of [...pending]) {
        pending.delete(handle);
        handler();
      }
    },
    armed(): number {
      return pending.size;
    },
  };
}

const response = (): Response => new Response("{}", { status: 200 });

describe("createWindowGuard", () => {
  it("reports no window before one is opened", () => {
    const guard = createWindowGuard({ timers: manualTimers(), now: () => 1_000 });
    expect(guard.remainingMs()).toBeNull();
  });

  it("reports what is left of an open window", () => {
    const guard = createWindowGuard({ timers: manualTimers(), now: () => 1_000 });
    guard.open(91_000);
    expect(guard.remainingMs()).toBe(90_000);
  });

  it("never reports a negative remainder for a window already over", () => {
    const guard = createWindowGuard({ timers: manualTimers(), now: () => 100_000 });
    guard.open(91_000);
    expect(guard.remainingMs()).toBe(0);
  });

  it("leaves the foreground unbounded", async () => {
    const timers = manualTimers();
    const guard = createWindowGuard({ timers, now: () => 1_000 });
    let seen: RequestInit | undefined;
    const bound = guard.boundFetch(async (_input, init) => {
      seen = init;
      return response();
    });

    await bound("https://example.test/sync/exchange");

    expect(seen?.signal).toBeUndefined();
    expect(timers.armed()).toBe(0);
  });

  it("gives a request in an open window a signal that trips at the deadline", async () => {
    const timers = manualTimers();
    const guard = createWindowGuard({ timers, now: () => 1_000 });
    guard.open(91_000);
    let seen: AbortSignal | null | undefined;
    const bound = guard.boundFetch(async (_input, init) => {
      seen = init?.signal;
      // The request is still in flight when the window closes.
      timers.fire();
      return response();
    });

    await bound("https://example.test/sync/exchange");

    expect(seen?.aborted).toBe(true);
  });

  it("disarms the timer once the response's headers arrive", async () => {
    const timers = manualTimers();
    const guard = createWindowGuard({ timers, now: () => 1_000 });
    guard.open(91_000);
    const bound = guard.boundFetch(async () => response());

    await bound("https://example.test/sync/exchange");

    expect(timers.armed()).toBe(0);
  });

  it("disarms the timer when the request fails", async () => {
    const timers = manualTimers();
    const guard = createWindowGuard({ timers, now: () => 1_000 });
    guard.open(91_000);
    const bound = guard.boundFetch(async () => {
      throw new Error("connection reset");
    });

    await expect(bound("https://example.test/sync/exchange")).rejects.toThrow("connection reset");
    expect(timers.armed()).toBe(0);
  });

  it("keeps a caller's own signal working through the wrapper", async () => {
    const timers = manualTimers();
    const guard = createWindowGuard({ timers, now: () => 1_000 });
    guard.open(91_000);
    const caller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const bound = guard.boundFetch(async (_input, init) => {
      seen = init?.signal;
      caller.abort();
      return response();
    });

    await bound("https://example.test/sync/exchange", { signal: caller.signal });

    expect(seen?.aborted).toBe(true);
  });

  it("stops bounding once the window closes", async () => {
    const timers = manualTimers();
    const guard = createWindowGuard({ timers, now: () => 1_000 });
    guard.open(91_000);
    guard.close();
    let seen: RequestInit | undefined;
    const bound = guard.boundFetch(async (_input, init) => {
      seen = init;
      return response();
    });

    await bound("https://example.test/sync/exchange");

    expect(seen?.signal).toBeUndefined();
  });

  it("hands a native transfer a bound only while a window is open", () => {
    const timers = manualTimers();
    const guard = createWindowGuard({ timers, now: () => 1_000 });
    expect(guard.transferAbort()).toBeNull();
    guard.open(91_000);
    const abort = guard.transferAbort();
    expect(abort).not.toBeNull();
    timers.fire();
    expect(abort?.signal.aborted).toBe(true);
  });
});
