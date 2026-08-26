import { beforeEach, describe, expect, it, vi } from "vitest";

const sweep = vi.hoisted(() => ({
  active: false,
  start: vi.fn(async () => ({ ok: true as const, state: {} as never })),
  idle: Promise.resolve(),
  waitForIdle: vi.fn(() => sweep.idle),
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
} from "@/derivation/ingest-watch";

function resetWatch(): void {
  const key = Symbol.for("starkeep.photos.derivation.ingestWatch");
  delete (globalThis as unknown as Record<symbol, unknown>)[key];
}

beforeEach(() => {
  resetWatch();
  sweep.active = false;
  sweep.idle = Promise.resolve();
  sweep.start.mockClear();
  sweep.waitForIdle.mockClear();
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
