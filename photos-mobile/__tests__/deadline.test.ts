/**
 * Bounding a call that may never return, against a clock a test controls.
 *
 * Every one of these is a property the app depends on in a background window
 * and cannot observe there: a timer that fires when nobody is watching, a race
 * whose loser is abandoned rather than cancelled, an abort that reaches the
 * socket. A test that had to wait out a real timeout would be a test nobody
 * runs, so the timers are supplied.
 */
import { describe, it, expect } from "vitest";
import { EXPIRED, abortAfter, raceDeadline, withDeadline, type Timers } from "../src/deadline";

/** A timer set nothing drives but the test. */
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

describe("raceDeadline", () => {
  it("returns the work when the work answers first", async () => {
    const timers = manualTimers();
    await expect(raceDeadline(Promise.resolve("rows"), { ms: 100, timers })).resolves.toBe("rows");
  });

  it("disarms the timer once the work has answered", async () => {
    const timers = manualTimers();
    await raceDeadline(Promise.resolve("rows"), { ms: 100, timers });
    expect(timers.armed()).toBe(0);
  });

  it("resolves EXPIRED when the deadline passes first", async () => {
    const timers = manualTimers();
    const race = raceDeadline(new Promise<string>(() => undefined), { ms: 100, timers });
    timers.fire();
    await expect(race).resolves.toBe(EXPIRED);
  });

  it("passes a failure through rather than reporting a deadline", async () => {
    const timers = manualTimers();
    const race = raceDeadline(Promise.reject(new Error("no such asset")), { ms: 100, timers });
    await expect(race).rejects.toThrow("no such asset");
    expect(timers.armed()).toBe(0);
  });

  it("arms nothing at all when no deadline is given", async () => {
    const timers = manualTimers();
    await expect(raceDeadline(Promise.resolve(1), { timers })).resolves.toBe(1);
    expect(timers.armed()).toBe(0);
  });
});

describe("withDeadline", () => {
  it("throws the caller's error once the deadline passes", async () => {
    const timers = manualTimers();
    const work = withDeadline(new Promise<string>(() => undefined), {
      ms: 100,
      timers,
      onExpiry: () => new Error("the media store did not answer"),
    });
    timers.fire();
    await expect(work).rejects.toThrow("the media store did not answer");
  });
});

describe("abortAfter", () => {
  it("aborts once the deadline passes", () => {
    const timers = manualTimers();
    const abort = abortAfter(100, timers);
    expect(abort.signal.aborted).toBe(false);
    timers.fire();
    expect(abort.signal.aborted).toBe(true);
  });

  it("aborts as soon as a linked signal does", () => {
    const timers = manualTimers();
    const caller = new AbortController();
    const abort = abortAfter(100, timers, caller.signal);
    caller.abort();
    expect(abort.signal.aborted).toBe(true);
  });

  it("is already aborted when the linked signal was", () => {
    const timers = manualTimers();
    const caller = new AbortController();
    caller.abort();
    expect(abortAfter(100, timers, caller.signal).signal.aborted).toBe(true);
  });

  it("disarms on release, so a request that finished cannot be aborted later", () => {
    const timers = manualTimers();
    const abort = abortAfter(100, timers);
    abort.release();
    timers.fire();
    expect(abort.signal.aborted).toBe(false);
  });
});
