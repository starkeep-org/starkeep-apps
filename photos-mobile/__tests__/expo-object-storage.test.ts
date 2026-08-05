/**
 * `ObjectStorageAdapter` over expo-file-system (item 11b).
 *
 * The fake filesystem below implements expo-file-system's *shape* — the
 * class-based `File` with `readableStream`, `writableStream` and an `open()`
 * handle carrying an `offset` — over an in-memory map. What that leaves untested
 * is whether expo-file-system honours its own documented behaviour, which only a
 * device settles and is recorded as a gap.
 *
 * The ranged read is the case worth the most attention: it is what video seeking
 * depends on, and reading from zero and discarding the prefix would satisfy
 * every assertion about *content* while turning a seek to the ten-minute mark
 * into a ten-minute read.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ExpoObjectStorageAdapter } from "../src/storage/expo-object-storage";
import { fakeExpoFs } from "./helpers/fake-expo-fs";

const HASH = "abcdef0123456789".repeat(4);
const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

let harness: ReturnType<typeof fakeExpoFs>;
let adapter: ExpoObjectStorageAdapter;

// Distinct per position, so an off-by-one is visible rather than hidden inside
// a run of identical bytes.
const PAYLOAD = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

beforeEach(async () => {
  harness = fakeExpoFs();
  adapter = new ExpoObjectStorageAdapter({ fs: harness.fs, basePath: "/docs/objects" });
  await adapter.init();
});

describe("basic storage", () => {
  it("round-trips bytes", async () => {
    await adapter.put(HASH, PAYLOAD);
    const result = await adapter.get(HASH);
    expect(result!.size).toBe(64);
    expect(Buffer.from(result!.data).equals(Buffer.from(PAYLOAD))).toBe(true);
  });

  it("reports absence rather than throwing", async () => {
    expect(await adapter.get("nope")).toBeNull();
    expect(await adapter.getStream("nope")).toBeNull();
    expect(await adapter.stat("nope")).toBeNull();
    expect(await adapter.has("nope")).toBe(false);
  });

  // Content-addressed keys are uniformly distributed hex, and a flat directory
  // of 60k entries is a listing nothing wants to perform.
  it("shards a bare hash into a two-character prefix", async () => {
    await adapter.put(HASH, PAYLOAD);
    expect([...harness.files.keys()].some((p) => p.includes(`/${HASH.slice(0, 2)}/`))).toBe(true);
  });

  it("leaves an already-pathed key alone", async () => {
    await adapter.put("shared/image/ab/thing", PAYLOAD);
    expect(harness.files.has("/docs/objects/shared/image/ab/thing")).toBe(true);
  });
});

describe("ranged reads", () => {
  beforeEach(async () => {
    await adapter.put(HASH, PAYLOAD);
  });

  it("returns exactly the requested inclusive range", async () => {
    const stream = await adapter.getStream(HASH, { start: 10, end: 19 });
    const bytes = await drain(stream!);
    // Ten bytes, because both ends are inclusive — matching HTTP and S3, so no
    // layer in between has to translate.
    expect(bytes.byteLength).toBe(10);
    expect(Buffer.from(bytes).equals(Buffer.from(PAYLOAD.subarray(10, 20)))).toBe(true);
  });

  it("reads to the end when no end is given", async () => {
    const bytes = await drain((await adapter.getStream(HASH, { start: 60 }))!);
    expect(Buffer.from(bytes).equals(Buffer.from(PAYLOAD.subarray(60)))).toBe(true);
  });

  // The property that makes seeking cheap. Reading from zero and slicing would
  // pass every content assertion above while doing the work this exists to
  // avoid.
  it("starts reading at the offset rather than from the beginning", async () => {
    await drain((await adapter.getStream(HASH, { start: 40, end: 47 }))!);
    expect(harness.state.rangedReads[0]!.offset).toBe(40);
    expect(harness.state.rangedReads.reduce((n, r) => n + r.length, 0)).toBe(8);
  });

  it("clamps an end past the end of the file", async () => {
    const bytes = await drain((await adapter.getStream(HASH, { start: 60, end: 9999 }))!);
    expect(bytes.byteLength).toBe(4);
  });

  it("returns an empty stream for a range past the end", async () => {
    const bytes = await drain((await adapter.getStream(HASH, { start: 999 }))!);
    expect(bytes.byteLength).toBe(0);
  });

  // A phone's open-file limit is low enough that a leak matters inside one
  // session, not just eventually.
  it("closes the handle when the range is fully read", async () => {
    await drain((await adapter.getStream(HASH, { start: 0, end: 63 }))!);
    expect(harness.state.openHandles).toBe(0);
  });

  it("closes the handle when a reader gives up early", async () => {
    const stream = await adapter.getStream(HASH, { start: 0, end: 63 });
    const reader = stream!.getReader();
    await reader.read();
    await reader.cancel();
    expect(harness.state.openHandles).toBe(0);
  });
});

describe("streamed writes", () => {
  const source = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

  it("round-trips a streamed write", async () => {
    await adapter.putStream(HASH, source(PAYLOAD), { contentType: "image/jpeg" });
    const bytes = await drain((await adapter.getStream(HASH))!);
    expect(Buffer.from(bytes).equals(Buffer.from(PAYLOAD))).toBe(true);
    expect((await adapter.stat(HASH))?.contentType).toBe("image/jpeg");
  });

  it("accepts a stream matching the expected digest", async () => {
    const { createHash } = await import("node:crypto");
    const hex = createHash("sha256").update(PAYLOAD).digest("hex");
    await adapter.putStream(HASH, source(PAYLOAD), { expectedSha256Hex: hex });
    expect(await adapter.has(HASH)).toBe(true);
  });

  // The write goes to a temporary name and is moved into place, so a stream
  // that fails partway leaves nothing at the key. A half-written file there
  // would look exactly like a complete one to has() — which is how a corrupt
  // object becomes something the durability predicate counts as a replica.
  it("leaves nothing at the key when the digest disagrees", async () => {
    await expect(
      adapter.putStream(HASH, source(PAYLOAD), { expectedSha256Hex: "0".repeat(64) }),
    ).rejects.toThrow();
    expect(await adapter.has(HASH)).toBe(false);
  });

  it("leaves no temporary file behind after a failed write", async () => {
    await expect(
      adapter.putStream(HASH, source(PAYLOAD), { expectedSha256Hex: "0".repeat(64) }),
    ).rejects.toThrow();
    expect([...harness.files.keys()].filter((p) => p.endsWith(".partial"))).toEqual([]);
  });

  // The temp file used to be read whole and written across, because "expo-file-
  // system has no rename on the File class in this shape". It does. The copy
  // materialized the entire object one line after the streaming write that
  // existed to avoid materializing it — on a phone, for a video, that is the
  // allocation that kills the process.
  it("renames the temporary file rather than copying its bytes", async () => {
    await adapter.putStream(HASH, source(PAYLOAD));
    expect(harness.state.moves).toEqual([
      { from: `/docs/objects/ab/${HASH}.partial`, to: `/docs/objects/ab/${HASH}` },
    ]);
  });

  it("overwrites an object already at the key", async () => {
    await adapter.put(HASH, new Uint8Array([9, 9, 9]));
    await adapter.putStream(HASH, source(PAYLOAD));
    expect(Buffer.from((await adapter.get(HASH))!.data).equals(Buffer.from(PAYLOAD))).toBe(true);
  });
});

describe("naming a file for the platform to send", () => {
  it("names a stored object", async () => {
    await adapter.put(HASH, PAYLOAD);
    expect(adapter.localFileUriFor(HASH)).toBe(`/docs/objects/ab/${HASH}`);
  });

  // Handing back a URI for a key this node does not hold would point the
  // uploader at a missing file: the transfer would fail rather than fall back
  // to the stream path, which is the one outcome the capability must not have.
  it("names nothing for a key it does not hold", () => {
    expect(adapter.localFileUriFor(HASH)).toBeNull();
  });
});

describe("what a phone cannot claim", () => {
  beforeEach(async () => {
    await adapter.put(HASH, PAYLOAD);
  });

  // Synthesising a hash here would be a lie about provenance: it would say the
  // store confirmed these bytes when nothing did. Callers must read null as
  // "unknown", never as "verified" and never as "mismatch".
  it("reports no checksum, because local storage verifies nothing", async () => {
    expect((await adapter.stat(HASH))?.checksumSha256).toBeNull();
  });

  it("reports instant availability, because there is no third state", async () => {
    expect((await adapter.stat(HASH))?.availability).toEqual({ state: "instant" });
  });

  it("satisfies a restore request rather than erroring", async () => {
    // A caller that restores defensively should not have to know which node it
    // is talking to. "already-in-progress" is the honest answer of the two
    // available — it means "do not wait on me", where "started" would invite
    // polling for a transition that never comes.
    await expect(adapter.restoreObject(HASH, { tier: "Standard", days: 1 })).resolves.toBe(
      "already-in-progress",
    );
  });

  // Tags are inert on a phone — there are no lifecycle rules — but stored so a
  // phone can answer the same questions a cloud node can.
  it("stores tags even though nothing acts on them", async () => {
    await adapter.setTags(HASH, { intent: "instant" });
    expect((await adapter.stat(HASH))?.contentType).toBeUndefined();
    await adapter.setTags(HASH, { ladder: "complete" });
    expect(await adapter.has(HASH)).toBe(true);
  });

  // This used to throw, on the argument that nothing on the phone path lists
  // object storage. That stopped being true when the resident-set index gained
  // a reconcile: the index is a cache of what this store holds, and a cache
  // with no way to be rebuilt drifts silently — a process killed between
  // `delete()` and the index update leaves a row claiming bytes that are gone.
  it("lists every stored key by walking the tree", async () => {
    await adapter.put(HASH, PAYLOAD);
    const other = "b".repeat(64);
    await adapter.put(`shared/image/${other.slice(0, 2)}/${other}`, PAYLOAD);

    const { keys } = await adapter.list("");
    expect(keys).toContain(`shared/image/${other.slice(0, 2)}/${other}`);
    expect(keys).toContain(`${HASH.slice(0, 2)}/${HASH}`);
  });

  it("filters by prefix", async () => {
    await adapter.put(HASH, PAYLOAD);
    const shared = `shared/image/aa/${"c".repeat(64)}`;
    await adapter.put(shared, PAYLOAD);

    expect((await adapter.list("shared/")).keys).toEqual([shared]);
  });

  // A sidecar is this adapter's own bookkeeping and a `.tmp.` file is a write
  // still in flight. Reporting either as a stored object would have a reconcile
  // adopt something that is not one — and, for the sidecar, charge a budget for
  // a few bytes of JSON under a key no record names.
  it("does not report sidecars or half-written files as objects", async () => {
    await adapter.put(HASH, PAYLOAD, { contentType: "image/jpeg" });
    harness.files.set(`/docs/objects/shared/image/aa/x.tmp.1`, PAYLOAD);

    const { keys } = await adapter.list("");
    expect(keys.some((k) => k.endsWith(".meta.json"))).toBe(false);
    expect(keys.some((k) => k.includes(".tmp."))).toBe(false);
  });
});

describe("deleting", () => {
  it("removes the object and its sidecar", async () => {
    await adapter.put(HASH, PAYLOAD, { contentType: "image/jpeg" });
    await adapter.delete(HASH);
    expect(await adapter.has(HASH)).toBe(false);
    expect([...harness.files.keys()].filter((p) => p.endsWith(".meta.json"))).toEqual([]);
  });

  it("is a no-op for something that is not there", async () => {
    await expect(adapter.delete("nope")).resolves.toBeUndefined();
  });
});
