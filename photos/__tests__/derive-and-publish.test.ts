/**
 * The derive-and-publish flow, against a fake data plane.
 *
 * The image encoding itself is sharp's and is not asserted here. What is
 * asserted is the *order and the arithmetic around it*, which is where the
 * expensive mistakes were:
 *
 *   - deriving the whole ladder and then discarding the rungs that already
 *     existed, so a complete record cost twenty-nine seconds to publish nothing;
 *   - writing the ~25-byte placeholder after every rung, so the cheapest thing
 *     in the app was gated behind the most expensive path in it;
 *   - decoding the source for its dimensions, using them for one comparison and
 *     throwing them away, leaving a watched-folder import with no `captured_at`
 *     and therefore filed entirely under its import date.
 *
 * Each of those is invisible in the output and obvious in the call sequence, so
 * the call sequence is what the fake records.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import sharp from "sharp";
import { deriveAndPublish } from "../src/photos-lib/image-processing/derive-and-publish";
import type { DerivationAttempt } from "../src/photos-lib/image-processing/derivation-attempts";
import type { SignedFetchInit } from "../src/photos-lib/image-processing/publish-renditions";
import { PHOTOS_APP_ID, PHOTOS_LABEL_KEYS } from "../src/photos-lib/labels";
import { STILL_LADDER, applicableStillClasses } from "../src/photos-lib/ladder";

/**
 * A data plane just real enough for this flow: renditions are child records
 * carrying the rendition label, metadata is a per-record bag, and presigned
 * uploads succeed.
 */
class FakePlane {
  calls: string[] = [];
  renditions: string[] = [];
  metadata: Record<string, unknown> = {};
  gateAsserted = false;
  uploads = 0;

  constructor(readonly parentId: string) {}

  fetch = async (path: string, init?: SignedFetchInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${path.split("?")[0]}`);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (path.startsWith("/data/records?")) {
      return json({
        records: this.renditions.map((sizeClass) => ({
          labels: [{ app_id: PHOTOS_APP_ID, key: PHOTOS_LABEL_KEYS.rendition, value: sizeClass }],
        })),
      });
    }
    if (path.endsWith("/metadata/image")) {
      const known = Object.keys(this.metadata).length > 0 ? this.metadata : null;
      return json({ metadata: known });
    }
    if (path.endsWith("/metadata")) {
      Object.assign(this.metadata, body.metadata as Record<string, unknown>);
      return json({ ok: true });
    }
    if (path === "/files/presign") {
      return json({ url: "https://uploads.invalid/put" });
    }
    if (path === "/data/records") {
      const labels = (body.labels ?? []) as Array<{ key: string; value: string }>;
      const sizeClass = labels[0]!.value;
      this.renditions.push(sizeClass);
      return json({ record: { id: `${this.parentId}-${sizeClass}` } });
    }
    if (path.endsWith("/archive-gate")) {
      this.gateAsserted = true;
      return json({ tagged: true, refusals: [] });
    }
    throw new Error(`unexpected call: ${method} ${path}`);
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A source large enough that the whole still ladder applies to it. */
async function bigJpeg(): Promise<Uint8Array> {
  const edge = STILL_LADDER[STILL_LADDER.length - 1]!.maxLongEdge + 100;
  const buf = await sharp({
    create: { width: edge, height: Math.round(edge * 0.75), channels: 3, background: { r: 90, g: 140, b: 200 } },
  })
    // IFD2 is the Exif IFD as sharp names it; DateTimeOriginal written into
    // IFD0 is silently dropped.
    .withExif({ IFD0: { Make: "TestMake" }, IFD2: { DateTimeOriginal: "2019:04:02 11:30:00" } })
    .jpeg({ quality: 60 })
    .toBuffer();
  return new Uint8Array(buf);
}

/**
 * Rendition bytes go up by presigned PUT to a URL the data plane hands back, so
 * that upload is the one call in this flow that is not a `signedFetch`. Stubbed
 * to succeed; what it carries is sharp's business.
 */
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://uploads.invalid/")) {
      plane.uploads += 1;
      return new Response(null, { status: 200 });
    }
    return realFetch(input as RequestInfo, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

let plane: FakePlane;
let source: Uint8Array;
let loads: number;

beforeEach(async () => {
  plane = new FakePlane("REC1");
  source = await bigJpeg();
  loads = 0;
});

const loadSource = async () => {
  loads += 1;
  return source;
};

const run = (over: Partial<Parameters<typeof deriveAndPublish>[0]> = {}) =>
  deriveAndPublish({
    signedFetch: plane.fetch,
    parent: { id: "REC1", originalFilename: "photo.jpg", mimeType: "image/jpeg" },
    loadSource,
    // Cheap enough for a test suite; AVIF at five rungs is not.
    codec: "jpeg",
    ...over,
  });

describe("a record with nothing derived yet", () => {
  it("publishes the placeholder and the record's own facts before any rung", async () => {
    await run();

    const firstRendition = plane.calls.indexOf("POST /data/records");
    const metadataWrites = plane.calls
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c === "POST /data/records/REC1/metadata")
      .map(([, i]) => i);

    expect(metadataWrites.length).toBeGreaterThan(0);
    expect(firstRendition).toBeGreaterThan(0);
    // Every write to the parent lands before the first rung is registered.
    for (const at of metadataWrites) expect(at).toBeLessThan(firstRendition);
    expect(plane.metadata.thumb_hash).toBeTypeOf("string");
  }, 60_000);

  it("writes the dimensions and the capture date it decoded anyway", async () => {
    await run();
    // Without captured_at a record sorts by its import date, so a watched-folder
    // import files an entire library under one day and then silently reorders
    // itself as photos are opened one at a time.
    expect(new Date(plane.metadata.captured_at as string).getFullYear()).toBe(2019);
    expect(plane.metadata.width).toBeGreaterThan(0);
    expect(plane.metadata.height).toBeGreaterThan(0);
    expect(plane.metadata.camera_make).toBe("TestMake");
  }, 60_000);

  it("publishes rungs smallest first", async () => {
    const result = await run();
    const order = result.published.map((p) => p.sizeClass);
    const ladderOrder = STILL_LADDER.map((s) => s.sizeClass as string);
    const positions = order.map((c) => ladderOrder.indexOf(c));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(order.length).toBe(applicableStillClasses(Number.MAX_SAFE_INTEGER).length);
  }, 60_000);

  it("asserts the archive gate once the ladder is complete", async () => {
    await run();
    expect(plane.gateAsserted).toBe(true);
  }, 60_000);
});

describe("a record that is already fully derived", () => {
  it("never downloads its original", async () => {
    await run();
    const before = loads;

    plane.calls = [];
    const again = await run();

    expect(again.published).toEqual([]);
    // The whole point: the second pass answers from two queries. Deriving the
    // ladder and then filtering out what already existed cost a full decode and
    // every encode to publish nothing.
    expect(loads).toBe(before);
    expect(plane.calls).not.toContain("POST /data/records");
  }, 60_000);

  it("re-publishes child records whose bytes are unavailable on this node", async () => {
    const sourceLongEdge = STILL_LADDER[STILL_LADDER.length - 1]!.maxLongEdge + 100;
    plane.metadata = {
      width: sourceLongEdge,
      height: Math.round(sourceLongEdge * 0.75),
      thumb_hash: "already-known",
    };
    plane.renditions = ["image-thumb", "image-xsmall"];

    const result = await run({
      targetLongEdge: STILL_LADDER[1]!.maxLongEdge,
      availableRenditionClasses: [],
    });

    expect(result.published.map((item) => item.sizeClass).sort()).toEqual([
      "image-thumb",
      "image-xsmall",
    ]);
    expect(loads).toBe(1);
  }, 60_000);
});

describe("asking for one size rather than the whole ladder", () => {
  it("derives the rung that answers it plus the ones the decode makes free", async () => {
    const result = await run({ targetLongEdge: STILL_LADDER[1]!.maxLongEdge });
    const got = result.published.map((p) => p.sizeClass).sort();
    expect(got).toEqual(["image-thumb", "image-xsmall"]);
    // And it does not claim a ladder it did not finish.
    expect(plane.gateAsserted).toBe(false);
  }, 60_000);

  it("is still idempotent — a second ask publishes nothing", async () => {
    const target = STILL_LADDER[1]!.maxLongEdge;
    await run({ targetLongEdge: target });
    const again = await run({ targetLongEdge: target });
    expect(again.published).toEqual([]);
  }, 60_000);
});

describe("a source this node cannot decode", () => {
  const store = () => {
    let held: DerivationAttempt | null = null;
    return {
      held: () => held,
      read: async () => held,
      write: async (a: DerivationAttempt) => {
        held = a.outcome === "complete" ? null : a;
      },
    };
  };

  it("records the verdict, and does not download the file again to re-fail", async () => {
    const attempts = store();
    const first = await run({
      loadSource: async () => {
        loads += 1;
        return new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      },
      attempts,
      parent: { id: "REC1", originalFilename: "photo.heic", mimeType: "image/heic" },
    });
    expect(first.outcome).toBe("undecodable-here");
    expect(attempts.held()?.outcome).toBe("undecodable-here");

    const before = loads;
    const second = await run({
      loadSource: async () => {
        loads += 1;
        return new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      },
      attempts,
      parent: { id: "REC1", originalFilename: "photo.heic", mimeType: "image/heic" },
    });
    expect(second.outcome).toBe("undecodable-here");
    // The one that matters. Without it, a sweep re-downloads and re-fails on
    // every HEIC in the library on every pass, forever.
    expect(loads).toBe(before);
  }, 60_000);
});
