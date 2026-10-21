import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySweepState, type SweepState } from "@/derivation/types";

const sweep = vi.hoisted(() => ({
  active: false,
  start: vi.fn(async () => ({ ok: true as const, state: {} as never })),
  idle: Promise.resolve() as Promise<unknown>,
  /** What each finished pass reports, in order; a clean pass once exhausted. */
  outcomes: [] as Array<Partial<SweepState>>,
  waitForIdle: vi.fn(),
}));

vi.mock("@/derivation/sweep-controller", () => ({
  isSweeping: () => sweep.active,
  startSweep: sweep.start,
  waitForSweepIdle: sweep.waitForIdle,
}));

import {
  consumeSseKicks,
  requestIngestSweep,
  startInitialSweep,
  UNAVAILABLE_RETRY_FIRST_MS,
  UNAVAILABLE_RETRY_MAX_MS,
} from "@/derivation/ingest-watch";

function resetWatch(): void {
  const key = Symbol.for("starkeep.photos.derivation.ingestWatch");
  delete (globalThis as unknown as Record<symbol, unknown>)[key];
}

beforeEach(() => {
  resetWatch();
  sweep.active = false;
  sweep.idle = Promise.resolve();
  sweep.outcomes = [];
  sweep.start.mockClear();
  sweep.waitForIdle.mockReset();
  sweep.waitForIdle.mockImplementation(async () => {
    await sweep.idle;
    return { ...emptySweepState(), completed: true, ...(sweep.outcomes.shift() ?? {}) };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the server-side ingest event stream", () => {
  it("ignores comments and delivers each payload-free data kick", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(": connected\n\ndata:"));
              controller.enqueue(encoder.encode(" \n\n: ping\n\ndata: \n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      ),
    );
    const kicks = vi.fn();

    await consumeSseKicks("http://127.0.0.1:9820/events", new AbortController().signal, kicks);

    expect(kicks).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe("the initial sweep", () => {
  it("starts immediately instead of waiting for a timer or an open page", async () => {
    await startInitialSweep();

    expect(sweep.start).toHaveBeenCalledOnce();
  });
});

describe("ingest sweep coalescing", () => {
  it("starts on the leading edge and retains only one trailing pass", async () => {
    let finish!: () => void;
    sweep.idle = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const first = requestIngestSweep();
    void requestIngestSweep();
    void requestIngestSweep();

    expect(sweep.start).toHaveBeenCalledOnce();
    finish();
    await first;
    await vi.waitFor(() => expect(sweep.start).toHaveBeenCalledTimes(2));
  });

  it("retains a trailing pass for a sweep started outside the watcher", async () => {
    let finish!: () => void;
    sweep.active = true;
    sweep.idle = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const joined = requestIngestSweep();
    expect(sweep.start).not.toHaveBeenCalled();

    sweep.active = false;
    finish();
    await joined;
    await vi.waitFor(() => expect(sweep.start).toHaveBeenCalledOnce());
  });
});

describe("a pass that could not fetch some sources", () => {
  // The device-test case: a phone's video record arrives, the kick's sweep asks
  // for an original whose upload has not finished, and the upload landing
  // later sends no kick at all.
  it("retries on its own, backing off, and resets after a clean pass", async () => {
    vi.useFakeTimers();
    sweep.outcomes = [{ unavailable: 2 }, { unavailable: 1 }, {}];

    await requestIngestSweep();
    expect(sweep.start).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_FIRST_MS - 1);
    expect(sweep.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep.start).toHaveBeenCalledTimes(2);

    // Still one missing: the next wait doubles.
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_FIRST_MS);
    expect(sweep.start).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_FIRST_MS);
    expect(sweep.start).toHaveBeenCalledTimes(3);

    // The third pass found everything, so nothing more is scheduled.
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MAX_MS * 2);
    expect(sweep.start).toHaveBeenCalledTimes(3);

    // And the backoff starts over for the next miss.
    sweep.outcomes = [{ unavailable: 1 }];
    await requestIngestSweep();
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_FIRST_MS);
    expect(sweep.start).toHaveBeenCalledTimes(5);
  });

  it("never waits longer than the cap", async () => {
    vi.useFakeTimers();
    sweep.outcomes = Array.from({ length: 8 }, () => ({ unavailable: 1 }));
    await requestIngestSweep();
    let waited = 0;
    for (let delay = UNAVAILABLE_RETRY_FIRST_MS; sweep.start.mock.calls.length < 8; delay *= 2) {
      const step = Math.min(delay, UNAVAILABLE_RETRY_MAX_MS);
      await vi.advanceTimersByTimeAsync(step);
      waited += step;
    }
    expect(sweep.start).toHaveBeenCalledTimes(8);
    expect(waited).toBe(60_000 * (1 + 2 + 4 + 8) + UNAVAILABLE_RETRY_MAX_MS * 3);
  });

  it("lets a kick replace a pending retry instead of adding a second pass", async () => {
    vi.useFakeTimers();
    sweep.outcomes = [{ unavailable: 1 }];
    await requestIngestSweep();

    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_FIRST_MS / 2);
    await requestIngestSweep();
    expect(sweep.start).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MAX_MS * 2);
    expect(sweep.start).toHaveBeenCalledTimes(2);
  });

  it("does not retry a pass whose only failures waiting cannot fix", async () => {
    vi.useFakeTimers();
    sweep.outcomes = [{ failed: 3, undecodable: 1 }];
    await requestIngestSweep();
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MAX_MS * 2);
    expect(sweep.start).toHaveBeenCalledTimes(1);
  });
});
