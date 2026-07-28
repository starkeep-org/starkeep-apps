/**
 * face-index end to end against a real local-data-server.
 *
 * This app exists to be a **second** app. Everything asserted here is about
 * the cross-app boundary, which is the part the old `records.label` column
 * could not express:
 *
 *   - writing a label holding only a `read` grant (§5.2)
 *   - a reverse query across a namespace the caller doesn't own (§7)
 *   - `app_id` server-set, so squatting is unrepresentable (§5.1)
 *
 * An equivalent module inside Photos would be the origin app labelling its own
 * records — the degenerate case — and would test none of it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import {
  installAppDirect,
  createRecordWithBytes,
  listRecords,
  solidPng,
  type LdsApp,
} from "@starkeep/e2e";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runIndexPass, APP_ID, type Fetcher } from "../src/index-pass.js";
import { detectFaceCount } from "../src/detect.js";

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../starkeep.manifest.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

/** Stands in for Photos: owns the images. */
const ownerManifest = {
  id: "image-owner",
  name: "Image Owner",
  version: "1.0.0",
  tier: "community",
  infraRequirements: {
    fileAccess: [
      { types: ["image/png"], access: "readwrite", rationale: "owns the images" },
    ],
  },
};

let server: LocalDataServer;
let owner: LdsApp;
let faceIndex: LdsApp;
let fetchAsFaceIndex: Fetcher;
const imageIds: string[] = [];

beforeAll(async () => {
  server = await startLocalDataServer();
  owner = await installAppDirect(server.url, ownerManifest);
  faceIndex = await installAppDirect(server.url, manifest);
  fetchAsFaceIndex = (path, init) => faceIndex.fetch(path, init);

  for (let i = 0; i < 24; i++) {
    const { record } = await createRecordWithBytes(owner, {
      bytes: solidPng([i * 10, 40, 80]),
      fileName: `img-${i}.png`,
    });
    imageIds.push(record.id);
  }
}, 120_000);

afterAll(async () => {
  await server.stop();
});

describe("indexing pass", () => {
  it("labels images another app created, holding only a read grant", async () => {
    const result = await runIndexPass(fetchAsFaceIndex);

    expect(result.scanned).toBe(imageIds.length);
    // Every image with a nonzero detected count got labelled, and the ones
    // with zero were deliberately left alone.
    const expectedLabelled = imageIds.filter((id) => detectFaceCount(id) > 0).length;
    expect(result.labelled).toBe(expectedLabelled);
    expect(result.skipped).toBe(imageIds.length - expectedLabelled);
    expect(result.labelled).toBeGreaterThan(0);
  });

  it("publishes the flag and the valued key under its own namespace", async () => {
    const withFaces = imageIds.find((id) => detectFaceCount(id) > 0)!;
    const labels = await labelsOf(owner, withFaces);

    expect(labels.map((l) => l.label).sort()).toEqual([
      "face-index/face-count",
      "face-index/faces-detected",
    ]);
    // The namespace came from face-index's authenticated identity — it never
    // sent an app id, and could not have sent a different one.
    expect(labels.every((l) => l.app_id === APP_ID)).toBe(true);
    // A bare flag is the empty string, not null — there is no null in the
    // label model, and row-present vs row-absent is what carries the meaning.
    expect(labels.find((l) => l.key === "faces-detected")!.value).toBe("");
    expect(labels.find((l) => l.key === "face-count")!.value).toBe(
      String(detectFaceCount(withFaces)),
    );
  });

  it("has a fixture covering both the labelled and unlabelled cases", async () => {
    // Record ids are ULIDs, so the detector's output distribution is random
    // per run. Assert the spread up front rather than letting the two cases
    // below quietly skip when the draw doesn't cover them — a test that
    // silently asserts nothing is worse than one that fails.
    const counts = imageIds.map(detectFaceCount);
    expect(counts.filter((c) => c === 0).length).toBeGreaterThan(0);
    expect(counts.filter((c) => c > 0).length).toBeGreaterThan(0);
    expect(new Set(counts.filter((c) => c > 0)).size).toBeGreaterThan(1);
  });

  it("leaves face-less images unlabelled rather than labelling them zero", async () => {
    // A presence query has to mean "there are faces here". Publishing a
    // negative would make ?label=face-index/faces-detected match everything.
    const withoutFaces = imageIds.filter((id) => detectFaceCount(id) === 0);
    expect(withoutFaces.length).toBeGreaterThan(0);
    for (const id of withoutFaces) {
      expect(await labelsOf(owner, id)).toEqual([]);
    }
  });

  it("is idempotent — a second pass writes nothing new", async () => {
    const before = await reverseQuery(owner, "face-index/faces-detected");
    const second = await runIndexPass(fetchAsFaceIndex);

    expect(second.labelled).toBe(0);
    const after = await reverseQuery(owner, "face-index/faces-detected");
    expect(after.sort()).toEqual(before.sort());
  });

  it("lets the owning app find them with a reverse query it doesn't own", async () => {
    // The query labels exist for: image-owner asks "which of my images did
    // face-index flag?" without calling face-index at all.
    const flagged = await reverseQuery(owner, "face-index/faces-detected");
    const expected = imageIds.filter((id) => detectFaceCount(id) > 0);
    expect(flagged.sort()).toEqual(expected.sort());
  });

  it("supports exact-value matching on the valued key", async () => {
    // Drive the assertion off whatever count the fixture actually produced,
    // so this exercises a real value rather than skipping on an unlucky draw.
    const someCount = detectFaceCount(imageIds.find((id) => detectFaceCount(id) > 0)!);
    const expected = imageIds.filter((id) => detectFaceCount(id) === someCount);

    const matched = await reverseQuery(owner, "face-index/face-count", String(someCount));
    expect(matched.sort()).toEqual(expected.sort());
    // And it is exact, not a prefix or a range.
    for (const id of matched) expect(detectFaceCount(id)).toBe(someCount);
  });

  it("publishes its keys to the cross-app registry", async () => {
    // Discoverability is the reason keys are declared in a manifest rather
    // than counted at runtime — image-owner can see what face-index publishes
    // without reading face-index's source.
    const res = await owner.fetch("/data/label-keys?app=face-index");
    const { labelKeys } = (await res.json()) as {
      labelKeys: Array<{ label: string; description: string }>;
    };
    expect(labelKeys.map((k) => k.label).sort()).toEqual([
      "face-index/face",
      "face-index/face-count",
      "face-index/faces-detected",
    ]);
    expect(labelKeys.find((k) => k.label === "face-index/face-count")!.description).toContain(
      "How many faces",
    );
  });

  it("cannot write a key its manifest does not declare", async () => {
    const res = await faceIndex.fetch("/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId: imageIds[0], key: "smuggled" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("cannot modify or delete the images it labels", async () => {
    // It holds `read`. Labelling is additive and namespaced; that is the whole
    // argument for pricing a label write at a read grant rather than
    // readwrite, and it only holds if read really is read.
    const res = await faceIndex.fetch(`/data/records/${imageIds[0]}`, { method: "DELETE" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("cannot retract another app's label", async () => {
    await owner.fetch("/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId: imageIds[0], key: "reviewed" }] }),
    }).catch(() => {});

    // Retraction is scoped by a primary key containing the server-set app_id,
    // so this reaches nothing — a silent no-op rather than an error.
    const res = await faceIndex.fetch("/data/labels/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labels: [{ recordId: imageIds[0], key: "faces-detected" }],
      }),
    });
    expect(res.status).toBe(200);

    // Its own label is gone; nothing else was touched.
    const mine = (await labelsOf(owner, imageIds[0])).filter((l) => l.app_id === APP_ID);
    expect(mine.some((l) => l.key === "faces-detected")).toBe(false);
  });
});

describe("paging and batching", () => {
  /**
   * The two loops the app exists to demonstrate, and the two that a
   * single-page fixture leaves entirely unexercised: paging a listing to
   * exhaustion, and chunking label writes to stay inside DSQL's
   * 3,000-modified-rows transaction limit. Both are sized down here rather
   * than seeding thousands of images.
   */
  function countingFetcher(): { fetch: Fetcher; listCalls: string[]; writeSizes: number[] } {
    const listCalls: string[] = [];
    const writeSizes: number[] = [];
    const fetch: Fetcher = async (path, init) => {
      if (path.startsWith("/data/records")) listCalls.push(path);
      if (path === "/data/labels" && init?.body) {
        const { labels } = JSON.parse(String(init.body)) as { labels: unknown[] };
        writeSizes.push(labels.length);
      }
      return faceIndex.fetch(path, init);
    };
    return { fetch, listCalls, writeSizes };
  }

  it("visits every image exactly once across several pages", async () => {
    // Stopping on the first short page — or a cursor that failed to advance —
    // would silently skip images, and the pass would look like it succeeded.
    const { fetch, listCalls } = countingFetcher();
    const result = await runIndexPass(fetch, { pageSize: 5 });

    expect(result.scanned).toBe(imageIds.length);
    expect(listCalls.length).toBeGreaterThan(1);
    // Every page after the first carried a cursor.
    expect(listCalls.slice(1).every((p) => p.includes("cursor="))).toBe(true);
    expect(listCalls[0]).not.toContain("cursor=");
    // Nothing new to write: the earlier passes already labelled everything.
    // (`scanned` counts the already-indexed ones too; they are neither
    // labelled nor skipped, they are simply passed over.)
    expect(result.labelled).toBe(0);
    expect(result.skipped).toBe(imageIds.filter((id) => detectFaceCount(id) === 0).length);
  });

  it("flushes label writes in chunks instead of one oversized batch", async () => {
    // Retract everything first so this pass has real work to do.
    const labelled = imageIds.filter((id) => detectFaceCount(id) > 0);
    const retract = await faceIndex.fetch("/data/labels/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labels: labelled.flatMap((id) => [
          { recordId: id, key: "faces-detected" },
          { recordId: id, key: "face-count" },
        ]),
      }),
    });
    expect(retract.status).toBe(200);

    const { fetch, writeSizes } = countingFetcher();
    const result = await runIndexPass(fetch, { imagesPerBatch: 2 });

    expect(result.labelled).toBe(labelled.length);
    // Several writes, none over the batch size (2 images = 4 label rows).
    expect(writeSizes.length).toBeGreaterThan(1);
    expect(Math.max(...writeSizes)).toBeLessThanOrEqual(4);
    expect(writeSizes.reduce((a, b) => a + b, 0)).toBe(labelled.length * 2);

    // And the labels are all actually there afterwards — chunking is not
    // allowed to drop the remainder that never filled a batch.
    const flagged = await reverseQuery(owner, "face-index/faces-detected");
    expect(flagged.sort()).toEqual(labelled.sort());
  });

  it("keeps paging and chunking correct when both are small at once", async () => {
    const labelled = imageIds.filter((id) => detectFaceCount(id) > 0);
    await faceIndex.fetch("/data/labels/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labels: labelled.flatMap((id) => [
          { recordId: id, key: "faces-detected" },
          { recordId: id, key: "face-count" },
        ]),
      }),
    });

    const { fetch } = countingFetcher();
    const result = await runIndexPass(fetch, { pageSize: 3, imagesPerBatch: 2 });

    expect(result.scanned).toBe(imageIds.length);
    expect(result.labelled).toBe(labelled.length);
    expect((await reverseQuery(owner, "face-index/faces-detected")).sort()).toEqual(
      labelled.sort(),
    );
  });
});

/**
 * The set-valued key — the thing the primary-key widening bought, and the
 * question labels exist to answer: *which photos contain Alice?*, asked by an
 * app that holds only a read grant and never calls the labeller.
 *
 * Driven directly rather than through `runIndexPass`, because the mocked
 * detector produces a count and not names.
 */
describe("a set-valued key", () => {
  /** Three images used only here, so the passes above are unaffected. */
  let photoA: string;
  let photoB: string;
  let photoC: string;

  const setFaces = (recordId: string, values: string[]) =>
    faceIndex.fetch("/data/labels/values", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId, key: "face", values }] }),
    });

  const facesOn = async (recordId: string) =>
    (await labelsOf(owner, recordId))
      .filter((l) => l.app_id === APP_ID && l.key === "face")
      .map((l) => l.value)
      .sort();

  beforeAll(async () => {
    [photoA, photoB, photoC] = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const { record } = await createRecordWithBytes(owner, {
          bytes: solidPng([200 + i, 10, 10]),
          fileName: `faces-${i}.png`,
        });
        return record.id;
      }),
    );
  }, 60_000);

  it("keeps every value of one key as its own row", async () => {
    // The whole point: packed into one row as "Alice,Bob" this is a substring
    // match no index can serve, and one that matches "Alicent" besides.
    const res = await faceIndex.fetch("/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labels: [
          { recordId: photoA, key: "face", value: "Alice" },
          { recordId: photoA, key: "face", value: "Bob" },
          { recordId: photoB, key: "face", value: "Alice" },
          { recordId: photoC, key: "face", value: "Alicent" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await facesOn(photoA)).toEqual(["Alice", "Bob"]);
  });

  it("answers the reverse query by exact value, across a namespace it doesn't own", async () => {
    const withAlice = await reverseQuery(owner, "face-index/face", "Alice");
    expect(withAlice.sort()).toEqual([photoA, photoB].sort());

    // Exact, not a prefix: "Alice" must not drag in "Alicent". This is the bug
    // a substring match would have shipped with, and it looks like it works
    // right up until someone is named a superstring of someone else.
    expect(withAlice).not.toContain(photoC);
  });

  it("a plain write adds rather than replaces", async () => {
    // The sharp edge of the widened primary key, and one that produces no
    // error — which is why the set-valued write exists at all.
    await faceIndex.fetch("/data/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId: photoB, key: "face", value: "Bob" }] }),
    });
    expect(await facesOn(photoB)).toEqual(["Alice", "Bob"]);
  });

  it("the set-valued write makes the key hold exactly what it was given", async () => {
    // Alice kept, Bob tombstoned, Carol added — the diff a caller would
    // otherwise compute itself, from a read it would have to do first, without
    // atomicity.
    expect((await setFaces(photoA, ["Alice", "Carol"])).status).toBe(200);
    expect(await facesOn(photoA)).toEqual(["Alice", "Carol"]);

    // And the reverse index follows: Bob's row is a tombstone, not a match.
    expect(await reverseQuery(owner, "face-index/face", "Bob")).toEqual([photoB]);
  });

  it("an empty value set clears the key", async () => {
    expect((await setFaces(photoC, [])).status).toBe(200);
    expect(await facesOn(photoC)).toEqual([]);
  });

  it("re-setting a retracted value revives it", async () => {
    // A set → retract → set cycle has to end with a live row; without the
    // upsert clearing deleted_at it writes one that stays invisible forever.
    expect((await setFaces(photoC, ["Alicent"])).status).toBe(200);
    expect(await facesOn(photoC)).toEqual(["Alicent"]);
  });

  it("retracting without a value takes back every value of the key", async () => {
    await setFaces(photoA, ["Alice", "Carol", "Dave"]);
    const res = await faceIndex.fetch("/data/labels/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [{ recordId: photoA, key: "face" }] }),
    });
    expect(res.status).toBe(200);
    expect(await facesOn(photoA)).toEqual([]);
  });

  it("retracting with a value takes back only that one", async () => {
    await setFaces(photoA, ["Alice", "Carol"]);
    const res = await faceIndex.fetch("/data/labels/retract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labels: [{ recordId: photoA, key: "face", value: "Carol" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await facesOn(photoA)).toEqual(["Alice"]);
  });

  it("separates a bare-flag query from an unfiltered one", async () => {
    // `?labelValue=` asks for bare flags; omitting it asks for any value. Read
    // as the same thing, the first returns a superset — which looks like it
    // works. face-index's own flag key is the fixture: it has values nowhere.
    const flagged = await reverseQuery(owner, "face-index/faces-detected", "");
    const anyValue = await reverseQuery(owner, "face-index/faces-detected");
    expect(flagged.sort()).toEqual(anyValue.sort());

    // On a key that does carry values, the two differ — and the empty-valued
    // query matches nothing, because no `face` row is a bare flag.
    expect(await reverseQuery(owner, "face-index/face", "")).toEqual([]);
    expect((await reverseQuery(owner, "face-index/face")).length).toBeGreaterThan(0);
  });

  it("caps values per key, counting what is already stored", async () => {
    // The cap is the value-side counterpart of the per-app key cap, and it only
    // does its job if it counts stored rows: over the batch alone it is cleared
    // by sending 32 values repeatedly, which is exactly the smuggling channel
    // it exists to close.
    const name = (i: number) => `person-${String(i).padStart(2, "0")}`;
    const write = (values: string[]) =>
      faceIndex.fetch("/data/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          labels: values.map((value) => ({ recordId: photoB, key: "face", value })),
        }),
      });

    await setFaces(photoB, []);
    const first = await write(Array.from({ length: 30 }, (_, i) => name(i)));
    expect(first.status).toBe(200);

    // 30 stored + 5 new = 35, over the 32 cap, even though the batch is small.
    const second = await write(Array.from({ length: 5 }, (_, i) => name(30 + i)));
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("32 values");

    // Re-writing values it already has costs nothing — a slot is a value, not
    // a write.
    const rewrite = await write(Array.from({ length: 30 }, (_, i) => name(i)));
    expect(rewrite.status).toBe(200);

    // One batch over the cap fails on its own too.
    await setFaces(photoB, []);
    const oversized = await write(Array.from({ length: 33 }, (_, i) => name(i)));
    expect(oversized.status).toBe(400);

    await setFaces(photoB, ["Alice", "Bob"]);
  });
});

// ---- helpers ---------------------------------------------------------------

interface WireLabel {
  app_id: string;
  key: string;
  value: string;
  label: string;
}

async function labelsOf(app: LdsApp, recordId: string): Promise<WireLabel[]> {
  const rows = (await listRecords(app, "?include=labels&limit=1000")) as unknown as Array<{
    id: string;
    labels?: WireLabel[];
  }>;
  return rows.find((r) => r.id === recordId)?.labels ?? [];
}

/** Page to exhaustion — a short page does not mean the end, only a null cursor does. */
async function reverseQuery(app: LdsApp, label: string, value?: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const res = await app.fetch(
      `/data/records?label=${encodeURIComponent(label)}&limit=5` +
        (value !== undefined ? `&labelValue=${encodeURIComponent(value)}` : "") +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
    );
    if (!res.ok) throw new Error(`reverse query failed: ${res.status}`);
    const body = (await res.json()) as {
      records: Array<{ id: string }>;
      nextCursor: string | null;
    };
    ids.push(...body.records.map((r) => r.id));
    cursor = body.nextCursor;
    if (++guard > 50) throw new Error("cursor failed to advance");
  } while (cursor !== null);
  return ids;
}
