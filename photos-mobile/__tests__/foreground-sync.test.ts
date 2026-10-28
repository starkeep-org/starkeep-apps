/**
 * Syncing while the app is open: the gate, the follow-up, the timer loop, and
 * the media-change debounce.
 *
 * Each of these is a rule about time or about not doing something twice, which
 * is exactly what is impossible to see on a device and easy to pin here with a
 * fake clock.
 */
import { describe, it, expect } from "vitest";
import {
  createDebouncer,
  createForegroundSyncLoop,
  createSyncFollowUp,
  FOREGROUND_SYNC_INTERVAL_MS,
  MEDIA_CHANGE_DEBOUNCE_MS,
  mayAutoSync,
  photosChannelOnly,
  uploadsMayRun,
  type Timers,
} from "../src/work/foreground-sync";
import type { DeviceState } from "../src/work/job-graph";

const WIFI: DeviceState = { hasNetwork: true, isUnmetered: true, isCharging: false, isStorageLow: false };

/** A clock that only moves when told to. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: Timers = {
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  async function advance(ms: number): Promise<void> {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].callback();
      // Let promise chains armed by the callback settle before the next timer.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    }
    now = until;
  }
  return { timers, advance, pendingCount: () => pending.size };
}

describe("mayAutoSync", () => {
  it("allows a ready node with a cloud on Wi-Fi", () => {
    expect(mayAutoSync({ nodeReady: true, hasCloud: true, device: WIFI })).toBe(true);
  });

  it("keeps the Wi-Fi gate: never on a metered connection", () => {
    expect(mayAutoSync({ nodeReady: true, hasCloud: true, device: { ...WIFI, isUnmetered: false } })).toBe(false);
  });

  it("declines offline, with no cloud, before the node opens, and when conditions are unknown", () => {
    expect(mayAutoSync({ nodeReady: true, hasCloud: true, device: { ...WIFI, hasNetwork: false } })).toBe(false);
    expect(mayAutoSync({ nodeReady: true, hasCloud: false, device: WIFI })).toBe(false);
    expect(mayAutoSync({ nodeReady: false, hasCloud: true, device: WIFI })).toBe(false);
    expect(mayAutoSync({ nodeReady: true, hasCloud: true, device: null })).toBe(false);
  });
});

describe("photosChannelOnly", () => {
  it("runs Photos' own channel alone on a metered connection", () => {
    const metered = { ...WIFI, isUnmetered: false };
    expect(photosChannelOnly({ nodeReady: true, hasCloud: true, device: metered })).toBe(true);
  });

  it("leaves both channels to the ordinary sync on Wi-Fi", () => {
    expect(photosChannelOnly({ nodeReady: true, hasCloud: true, device: WIFI })).toBe(false);
  });

  it("runs nothing on a node not ready, with no cloud or with unknown conditions", () => {
    const metered = { ...WIFI, isUnmetered: false };
    expect(photosChannelOnly({ nodeReady: false, hasCloud: true, device: metered })).toBe(false);
    expect(photosChannelOnly({ nodeReady: true, hasCloud: false, device: metered })).toBe(false);
    expect(photosChannelOnly({ nodeReady: true, hasCloud: true, device: null })).toBe(false);
  });
});

describe("uploadsMayRun", () => {
  it("runs the uploader in the foreground on Wi-Fi", () => {
    expect(uploadsMayRun({ nodeReady: true, hasCloud: true, device: WIFI, foreground: true })).toBe(true);
  });

  it("stops it in the background, and on a metered or unknown connection", () => {
    expect(uploadsMayRun({ nodeReady: true, hasCloud: true, device: WIFI, foreground: false })).toBe(false);
    expect(
      uploadsMayRun({ nodeReady: true, hasCloud: true, device: { ...WIFI, isUnmetered: false }, foreground: true }),
    ).toBe(false);
    expect(uploadsMayRun({ nodeReady: true, hasCloud: true, device: null, foreground: true })).toBe(false);
  });
});

describe("createSyncFollowUp", () => {
  it("starts a sync when none runs", () => {
    const followUp = createSyncFollowUp();
    expect(followUp.request()).toBe("start");
    expect(followUp.running()).toBe(true);
  });

  it("remembers a request made while one runs, and runs it when that one ends", () => {
    // The derivation pass finishes while the post-import sync is still going:
    // its new rungs must ship, not wait for the next timer tick.
    const followUp = createSyncFollowUp();
    followUp.request();
    expect(followUp.request()).toBe("queued");
    expect(followUp.finished()).toBe(true);
    expect(followUp.running()).toBe(true);
    expect(followUp.finished()).toBe(false);
    expect(followUp.running()).toBe(false);
  });

  it("collapses many requests during one sync into one follow-up", () => {
    const followUp = createSyncFollowUp();
    followUp.request();
    followUp.request();
    followUp.request();
    followUp.request();
    expect(followUp.finished()).toBe(true);
    expect(followUp.finished()).toBe(false);
  });

  it("drops a waiting follow-up when cancelled", () => {
    const followUp = createSyncFollowUp();
    followUp.request();
    followUp.request();
    followUp.cancel();
    expect(followUp.finished()).toBe(false);
  });
});

describe("createForegroundSyncLoop", () => {
  it("ticks every interval while started", async () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createForegroundSyncLoop({ onTick: () => void ticks++, timers: clock.timers });
    loop.start();
    await clock.advance(FOREGROUND_SYNC_INTERVAL_MS * 3);
    expect(ticks).toBe(3);
  });

  it("stops ticking when stopped, and arms nothing more", async () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createForegroundSyncLoop({ onTick: () => void ticks++, timers: clock.timers });
    loop.start();
    await clock.advance(FOREGROUND_SYNC_INTERVAL_MS);
    loop.stop();
    await clock.advance(FOREGROUND_SYNC_INTERVAL_MS * 5);
    expect(ticks).toBe(1);
    expect(clock.pendingCount()).toBe(0);
    expect(loop.running).toBe(false);
  });

  it("does not let a slow tick queue a second one behind it", async () => {
    const clock = fakeTimers();
    let release: () => void = () => {};
    let ticks = 0;
    const loop = createForegroundSyncLoop({
      onTick: () => {
        ticks += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      timers: clock.timers,
    });
    loop.start();
    await clock.advance(FOREGROUND_SYNC_INTERVAL_MS);
    // The tick is still running; no timer is armed while it does.
    expect(clock.pendingCount()).toBe(0);
    await clock.advance(FOREGROUND_SYNC_INTERVAL_MS * 4);
    expect(ticks).toBe(1);
    release();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(clock.pendingCount()).toBe(1);
  });

  it("keeps ticking after a tick that throws", async () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createForegroundSyncLoop({
      onTick: () => {
        ticks += 1;
        throw new Error("[test] sync failed");
      },
      timers: clock.timers,
    });
    loop.start();
    await clock.advance(FOREGROUND_SYNC_INTERVAL_MS * 2);
    expect(ticks).toBe(2);
  });

  it("starts once however often it is started", async () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createForegroundSyncLoop({ onTick: () => void ticks++, timers: clock.timers });
    loop.start();
    loop.start();
    loop.start();
    await clock.advance(FOREGROUND_SYNC_INTERVAL_MS);
    expect(ticks).toBe(1);
  });
});

describe("createDebouncer", () => {
  it("acts once, after the last of a burst", async () => {
    const clock = fakeTimers();
    let calls = 0;
    const debouncer = createDebouncer(() => void calls++, MEDIA_CHANGE_DEBOUNCE_MS, clock.timers);
    for (let i = 0; i < 20; i += 1) {
      debouncer.trigger();
      await clock.advance(MEDIA_CHANGE_DEBOUNCE_MS / 2);
    }
    expect(calls).toBe(0);
    await clock.advance(MEDIA_CHANGE_DEBOUNCE_MS);
    expect(calls).toBe(1);
  });

  it("does nothing once cancelled", async () => {
    const clock = fakeTimers();
    let calls = 0;
    const debouncer = createDebouncer(() => void calls++, MEDIA_CHANGE_DEBOUNCE_MS, clock.timers);
    debouncer.trigger();
    debouncer.cancel();
    await clock.advance(MEDIA_CHANGE_DEBOUNCE_MS * 2);
    expect(calls).toBe(0);
  });
});
