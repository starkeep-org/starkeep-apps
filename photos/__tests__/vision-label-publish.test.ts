import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunkByRows,
  MAX_ROWS_PER_BATCH,
  planLabelPublish,
  publishFaceLabels,
  retractFaceLabels,
  type LabelValueWrite,
} from "@/vision/label-publish";
import { assignUnclusteredFaces, renamePerson } from "@/vision/clustering";
import { encodeEmbedding, normalize } from "@/vision/embeddings";
import { newPerson, readPeople, writePeople } from "@/vision/people";
import { writeFaceSidecar } from "@/vision/sidecars";
import { FACE_MODEL_ID } from "@/vision/models";
import { FACE_SIDECAR_VERSION, type DetectedFace } from "@/vision/types";
import { LABEL_VALUES_PER_KEY_MAX } from "@/photos-lib";

let root: string;
let previousDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-labels-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

function vectorAt(angle: number): Float32Array {
  return normalize(new Float32Array([Math.cos(angle), Math.sin(angle), 0, 0]));
}

function face(angle: number): DetectedFace {
  return {
    bbox: [0, 0, 10, 10],
    score: 0.9,
    kps: [
      [1, 1],
      [2, 1],
      [1.5, 2],
      [1, 3],
      [2, 3],
    ],
    embedding: encodeEmbedding(vectorAt(angle)),
    personId: null,
  };
}

function seed(recordId: string, angles: number[]): void {
  writeFaceSidecar(recordId, {
    v: FACE_SIDECAR_VERSION,
    model: FACE_MODEL_ID,
    processedAt: "2026-07-28T00:00:00.000Z",
    w: 100,
    h: 100,
    faces: angles.map(face),
  });
}

/** Collects the bodies a publish sends, and always succeeds. */
function recordingFetcher() {
  const batches: Array<{ labels: LabelValueWrite[] }> = [];
  const fetcher = async (path: string, init: RequestInit) => {
    expect(path).toBe("/data/labels/values");
    batches.push(JSON.parse(String(init.body)) as { labels: LabelValueWrite[] });
    return new Response("{}", { status: 200 });
  };
  return { batches, fetcher };
}

function valuesFor(
  batches: Array<{ labels: LabelValueWrite[] }>,
  recordId: string,
  key: string,
): string[] | undefined {
  for (const batch of batches) {
    const hit = batch.labels.find((l) => l.recordId === recordId && l.key === key);
    if (hit) return hit.values;
  }
  return undefined;
}

describe("planLabelPublish", () => {
  it("publishes one faces row per named person, not a joined list", () => {
    // The whole reason the label primary key was widened: a name *list* in one
    // 128-byte value is unqueryable by equality.
    seed("group", [0, Math.PI / 2]);
    assignUnclusteredFaces(0.45);
    const [alice, bob] = readPeople();
    renamePerson(alice.id, "Alice");
    renamePerson(bob.id, "Bob");

    const plan = planLabelPublish();
    const faces = plan.writes.find((w) => w.recordId === "group" && w.key === "faces")!;
    expect(faces.values).toEqual(["Alice", "Bob"]);
  });

  it("publishes face-count for every image with faces", () => {
    seed("two", [0, Math.PI / 2]);
    assignUnclusteredFaces(0.45);
    const count = planLabelPublish().writes.find((w) => w.key === "face-count")!;
    expect(count.values).toEqual(["2"]);
  });

  it("publishes neither key for a zero-face image", () => {
    // A negative would make `?label=photos/face-count` match every processed
    // image, which is the opposite of what a presence query is for.
    seed("empty", []);
    const plan = planLabelPublish();
    for (const write of plan.writes.filter((w) => w.recordId === "empty")) {
      expect(write.values).toEqual([]);
    }
    expect(plan.imagesWithFaces).toBe(0);
  });

  it("leaves faces empty while a cluster is unnamed, but still counts it", () => {
    // `faces` is gated on user effort; `face-count` is not. That asymmetry is
    // why both keys are published rather than just one.
    seed("unnamed", [0]);
    assignUnclusteredFaces(0.45);
    const plan = planLabelPublish();
    expect(plan.writes.find((w) => w.key === "faces")!.values).toEqual([]);
    expect(plan.writes.find((w) => w.key === "face-count")!.values).toEqual(["1"]);
  });

  it("deduplicates a person appearing twice in one photo", () => {
    seed("twice", [0, 0.01]);
    assignUnclusteredFaces(0.45);
    renamePerson(readPeople()[0].id, "Alice");
    const faces = planLabelPublish().writes.find((w) => w.key === "faces")!;
    expect(faces.values).toEqual(["Alice"]);
  });

  it("drops a name too long to store rather than truncating it", () => {
    // A truncated name is a *different* name — it would match a query for
    // neither the real one nor anything else.
    seed("long", [0]);
    assignUnclusteredFaces(0.45);
    renamePerson(readPeople()[0].id, "A".repeat(129));
    expect(planLabelPublish().writes.find((w) => w.key === "faces")!.values).toEqual([]);
  });

  it("caps values at the platform's per-key limit", () => {
    // The server rejects the whole batch over the cap, so one 40-person photo
    // would otherwise fail the entire publish. Clusters are built by hand here
    // rather than by assignment — the point under test is the cap, not whether
    // 40 synthetic vectors happen to separate.
    const people = Array.from({ length: 40 }, (_, i) => {
      const person = newPerson(vectorAt(i));
      person.name = `Person ${String(i).padStart(2, "0")}`;
      return person;
    });
    writePeople(people);
    writeFaceSidecar("crowd", {
      v: FACE_SIDECAR_VERSION,
      model: FACE_MODEL_ID,
      processedAt: "2026-07-28T00:00:00.000Z",
      w: 100,
      h: 100,
      faces: people.map((person, i) => ({ ...face(i), personId: person.id })),
    });

    const faces = planLabelPublish().writes.find((w) => w.key === "faces")!;
    expect(faces.values.length).toBe(LABEL_VALUES_PER_KEY_MAX);
    // Sorted-then-truncated, so the published subset is stable across runs.
    expect(faces.values[0]).toBe("Person 00");
  });
});

describe("chunkByRows", () => {
  it("chunks on rows, not on images", () => {
    // Rows per image is variable now that a key is set-valued, so a per-image
    // chunk size no longer bounds the transaction at all.
    const writes: LabelValueWrite[] = [
      { recordId: "a", key: "faces", values: Array.from({ length: 8 }, (_, i) => `n${i}`) },
      { recordId: "b", key: "faces", values: ["x"] },
      { recordId: "c", key: "faces", values: ["y", "z"] },
    ];
    const batches = chunkByRows(writes, 9);
    expect(batches).toHaveLength(2);
    expect(batches[0].map((w) => w.recordId)).toEqual(["a", "b"]);
    expect(batches[1].map((w) => w.recordId)).toEqual(["c"]);
  });

  it("counts an empty values list as one row, not zero", () => {
    // An empty set still tombstones, so it still costs transaction budget.
    const writes: LabelValueWrite[] = [
      { recordId: "a", key: "faces", values: [] },
      { recordId: "b", key: "faces", values: [] },
    ];
    expect(chunkByRows(writes, 1)).toHaveLength(2);
  });

  it("never emits an empty batch, even for an oversized single write", () => {
    const writes: LabelValueWrite[] = [
      { recordId: "a", key: "faces", values: Array.from({ length: 30 }, (_, i) => `n${i}`) },
    ];
    const batches = chunkByRows(writes, 5);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it("returns nothing for nothing", () => {
    expect(chunkByRows([])).toEqual([]);
  });
});

describe("publishFaceLabels", () => {
  it("uses the set-valued endpoint so a rename replaces rather than accumulates", () => {
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    renamePerson(readPeople()[0].id, "Alice");

    const first = recordingFetcher();
    return publishFaceLabels(first.fetcher).then(async () => {
      expect(valuesFor(first.batches, "a", "faces")).toEqual(["Alice"]);

      renamePerson(readPeople()[0].id, "Alicia");
      const second = recordingFetcher();
      await publishFaceLabels(second.fetcher);
      // The old name is absent from the set, which is what tombstones it — a
      // plain add would have left `Alice` sitting beside `Alicia`.
      expect(valuesFor(second.batches, "a", "faces")).toEqual(["Alicia"]);
    });
  });

  it("reports what it published", async () => {
    seed("a", [0]);
    seed("b", []);
    assignUnclusteredFaces(0.45);
    renamePerson(readPeople()[0].id, "Alice");

    const { fetcher } = recordingFetcher();
    const result = await publishFaceLabels(fetcher);
    expect(result).toMatchObject({ imagesWithFaces: 1, namesPublished: 1, recordsWritten: 4 });
  });

  it("surfaces a server rejection instead of reporting success", async () => {
    seed("a", [0]);
    const failing = async () => new Response("nope", { status: 403 });
    await expect(publishFaceLabels(failing)).rejects.toThrow(/403/);
  });
});

describe("MAX_ROWS_PER_BATCH", () => {
  it("leaves headroom under DSQL's 3,000-row transaction cap", () => {
    // The set-valued write emits tombstones alongside upserts, so the rows a
    // batch modifies exceed the values it sends. Chunking right at the cap
    // would fail only against the cloud, and only on the batches that happened
    // to retract something.
    expect(MAX_ROWS_PER_BATCH).toBeLessThan(3000);
    expect(MAX_ROWS_PER_BATCH).toBeGreaterThan(500);
  });

  it("splits a library large enough to exceed one transaction", () => {
    const writes: LabelValueWrite[] = Array.from({ length: MAX_ROWS_PER_BATCH + 10 }, (_, i) => ({
      recordId: `rec-${i}`,
      key: "face-count",
      values: ["1"],
    }));
    const batches = chunkByRows(writes);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const rows = batch.reduce((n, w) => n + Math.max(1, w.values.length), 0);
      expect(rows).toBeLessThanOrEqual(MAX_ROWS_PER_BATCH);
    }
  });
});

describe("publishing an empty store", () => {
  it("sends no requests when nothing has been scanned", async () => {
    // Turning the toggle on before the first scan should be silent, not a
    // round trip that writes nothing.
    const { batches, fetcher } = recordingFetcher();
    const result = await publishFaceLabels(fetcher);
    expect(batches).toEqual([]);
    expect(result).toMatchObject({ recordsWritten: 0, batches: 0 });
  });

  it("retracts nothing when nothing has been scanned", async () => {
    const { batches, fetcher } = recordingFetcher();
    await retractFaceLabels(fetcher);
    expect(batches).toEqual([]);
  });
});

describe("retractFaceLabels", () => {
  it("clears both keys on every processed record", async () => {
    // Turning the toggle off has to actually un-publish; leaving the rows would
    // make it a lie about the disclosure it controls.
    seed("a", [0]);
    seed("b", []);
    assignUnclusteredFaces(0.45);
    renamePerson(readPeople()[0].id, "Alice");

    const { batches, fetcher } = recordingFetcher();
    await retractFaceLabels(fetcher);
    const all = batches.flatMap((b) => b.labels);
    expect(all).toHaveLength(4);
    expect(all.every((w) => w.values.length === 0)).toBe(true);
    expect(new Set(all.map((w) => w.key))).toEqual(new Set(["faces", "face-count"]));
  });
});
