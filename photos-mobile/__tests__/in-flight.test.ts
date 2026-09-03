/**
 * One request per key at a time, and only so many at once.
 *
 * Both rules exist because of how a grid asks for renditions. The same record's
 * rung is asked for by the tile that scrolled past it, by the reload that
 * followed an import and by the viewer somebody opened it in; and even
 * deduplicated, a screen of tiles with nothing resident is thirty requests in a
 * frame, against a Lambda concurrency ceiling one page load of the web app can
 * already exhaust.
 *
 * The tests are written against a controllable clock of promises rather than
 * timers, because both properties are about *ordering* and a test that waited on
 * real time would assert a delay instead.
 */
import { describe, it, expect } from "vitest";
import { createInFlight } from "../src/work/in-flight";

/** A promise plus the handles to settle it, so a test decides when work ends. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-resolved microtask run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("collapsing concurrent calls for one key", () => {
  it("runs the work once and gives every caller the same answer", async () => {
    const flight = createInFlight({ limit: 3 });
    const gate = deferred<string>();
    let ran = 0;

    const a = flight.run("photo:640", () => {
      ran += 1;
      return gate.promise;
    });
    const b = flight.run("photo:640", () => {
      ran += 1;
      return gate.promise;
    });

    gate.resolve("bytes");

    expect(await a).toBe("bytes");
    expect(await b).toBe("bytes");
    expect(ran).toBe(1);
  });

  it("fails every caller together rather than only the first", async () => {
    // They joined one request, so they share its outcome. A shared failure that
    // reached one caller would look like a failure of one tile.
    const flight = createInFlight({ limit: 3 });
    const gate = deferred<string>();

    const a = flight.run("photo:640", () => gate.promise);
    const b = flight.run("photo:640", () => gate.promise);
    gate.reject(new Error("offline"));

    await expect(a).rejects.toThrow("offline");
    await expect(b).rejects.toThrow("offline");
  });

  it("keeps different keys apart", async () => {
    const flight = createInFlight({ limit: 3 });
    let ran = 0;

    await Promise.all([
      flight.run("photo:640", async () => void (ran += 1)),
      flight.run("photo:1280", async () => void (ran += 1)),
      flight.run("other:640", async () => void (ran += 1)),
    ]);

    expect(ran).toBe(3);
  });

  it("runs again after the first call settles", async () => {
    // Deliberately not a cache. The reason to ask twice is that something
    // changed — the blob was evicted, the first attempt failed, the record was
    // re-derived — and a memo would answer all three from a stale result.
    const flight = createInFlight({ limit: 3 });
    let ran = 0;
    const work = async () => void (ran += 1);

    await flight.run("photo:640", work);
    await flight.run("photo:640", work);

    expect(ran).toBe(2);
  });

  it("forgets a key that failed, so the next caller may try again", async () => {
    const flight = createInFlight({ limit: 3 });
    await flight.run("photo:640", () => Promise.reject(new Error("offline"))).catch(() => {});

    await expect(flight.run("photo:640", async () => "bytes")).resolves.toBe("bytes");
    expect(flight.pending).toBe(0);
  });
});

describe("the ceiling on how many run at once", () => {
  it("admits the limit and makes the rest wait", async () => {
    const flight = createInFlight({ limit: 3 });
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    let started = 0;

    for (const [index, gate] of gates.entries()) {
      void flight.run(`photo:${index}`, () => {
        started += 1;
        return gate.promise;
      });
    }
    await settle();

    expect(started).toBe(3);
    expect(flight.running).toBe(3);
    // All four are accounted for, which is what lets a caller tell "waiting"
    // from "never asked".
    expect(flight.pending).toBe(4);
  });

  it("hands a finished slot straight to whoever is next", async () => {
    const flight = createInFlight({ limit: 2 });
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];

    for (const [index, gate] of gates.entries()) {
      void flight.run(`photo:${index}`, () => {
        started.push(index);
        return gate.promise;
      });
    }
    await settle();
    expect(started).toEqual([0, 1]);

    gates[0]!.resolve();
    await settle();

    expect(started).toEqual([0, 1, 2]);
    expect(flight.running).toBe(2);
  });

  it("gives the slot back when the work throws", async () => {
    // A failure that kept its slot would shrink the pool one request at a time
    // until nothing could run at all — the kind of fault that only shows up on a
    // flaky connection and then never recovers.
    const flight = createInFlight({ limit: 1 });

    await flight.run("photo:0", () => Promise.reject(new Error("offline"))).catch(() => {});
    await expect(flight.run("photo:1", async () => "bytes")).resolves.toBe("bytes");
    expect(flight.running).toBe(0);
  });

  it("drains to empty once everything settles", async () => {
    const flight = createInFlight({ limit: 2 });

    await Promise.all([
      flight.run("a", async () => 1),
      flight.run("b", async () => 2),
      flight.run("c", async () => 3),
    ]);

    expect(flight.running).toBe(0);
    expect(flight.pending).toBe(0);
  });
});
