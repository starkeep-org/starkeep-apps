import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignUnclusteredFaces,
  facesByPerson,
  mergePeopleAndFaces,
  reclusterAll,
  reconcilePeopleToStore,
  renamePerson,
  splitFacesToNewPerson,
} from "@/vision/clustering";
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  meanEmbedding,
  normalize,
  updateCentroid,
} from "@/vision/embeddings";
import { newPerson, PersonAssigner, readPeople } from "@/vision/people";
import { readAllFaceSidecars, reapOrphanSidecars, writeFaceSidecar } from "@/vision/sidecars";
import { FACE_MODEL_ID } from "@/vision/models";
import { FACE_SIDECAR_VERSION, type DetectedFace } from "@/vision/types";

let root: string;
let previousDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "starkeep-cluster-"));
  previousDir = process.env.STARKEEP_DIR;
  process.env.STARKEEP_DIR = root;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  rmSync(root, { recursive: true, force: true });
});

/**
 * A unit vector in a 4-d space, `angle` radians around the first two axes.
 *
 * Small dimensionality on purpose: cosine similarity between two of these is
 * `cos(Δangle)`, so a test can state the similarity it wants directly rather
 * than hoping a random 512-d pair lands where it needs to.
 */
function vectorAt(angle: number): Float32Array {
  return normalize(new Float32Array([Math.cos(angle), Math.sin(angle), 0, 0]));
}

function face(embedding: Float32Array, score = 0.9): DetectedFace {
  return {
    bbox: [0, 0, 10, 10],
    score,
    kps: [
      [1, 1],
      [2, 1],
      [1.5, 2],
      [1, 3],
      [2, 3],
    ],
    embedding: encodeEmbedding(embedding),
    personId: null,
  };
}

function seed(recordId: string, faces: DetectedFace[]): void {
  writeFaceSidecar(recordId, {
    v: FACE_SIDECAR_VERSION,
    model: FACE_MODEL_ID,
    processedAt: "2026-07-28T00:00:00.000Z",
    w: 100,
    h: 100,
    faces,
  });
}

describe("embeddings codec", () => {
  it("round-trips a vector exactly", () => {
    const v = new Float32Array([0.5, -0.25, 1e-7, 0.125]);
    expect([...decodeEmbedding(encodeEmbedding(v))]).toEqual([...v]);
  });

  it("is compact enough to keep in a sidecar", () => {
    // 512 floats: 2 KB raw, ~2.7 KB base64 — versus the ~10 KB a JSON number
    // array would cost, per face, per photo.
    expect(encodeEmbedding(new Float32Array(512)).length).toBeLessThan(3000);
  });

  it("rejects a payload that is not a whole number of floats", () => {
    expect(() => decodeEmbedding(Buffer.from([1, 2, 3]).toString("base64"))).toThrow(/float32/);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for a vector against itself and 0 for an orthogonal pair", () => {
    expect(cosineSimilarity(vectorAt(0), vectorAt(0))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(vectorAt(0), vectorAt(Math.PI / 2))).toBeCloseTo(0, 6);
  });

  it("refuses to compare different-length vectors", () => {
    expect(() => cosineSimilarity(new Float32Array(4), new Float32Array(8))).toThrow(/length/);
  });
});

describe("updateCentroid", () => {
  it("moves the centroid toward the new face, weighted by cluster size", () => {
    const a = vectorAt(0);
    const b = vectorAt(Math.PI / 4);
    // A cluster of one moves halfway; a cluster of nine barely moves.
    const small = updateCentroid(a, 1, b);
    const large = updateCentroid(a, 9, b);
    expect(cosineSimilarity(small, a)).toBeLessThan(cosineSimilarity(large, a));
    expect(cosineSimilarity(large, a)).toBeGreaterThan(0.99);
  });

  it("keeps the centroid a unit vector", () => {
    const c = updateCentroid(vectorAt(0), 3, vectorAt(1));
    expect(cosineSimilarity(c, c)).toBeCloseTo(1, 6);
  });
});

describe("assignUnclusteredFaces", () => {
  it("groups similar faces and separates dissimilar ones", () => {
    // Two tight groups ~0.995 apart within, ~0.0 apart between.
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(0.1))]);
    seed("c", [face(vectorAt(Math.PI / 2))]);

    const { assigned, people } = assignUnclusteredFaces(0.45);
    expect(assigned).toBe(3);
    expect(people).toHaveLength(2);

    const byPerson = facesByPerson();
    const sizes = [...byPerson.values()].map((f) => f.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it("gives every face a person, including a cluster of one", () => {
    seed("solo", [face(vectorAt(0))]);
    assignUnclusteredFaces(0.45);
    const sidecar = readAllFaceSidecars().get("solo")!;
    expect(sidecar.faces[0].personId).not.toBeNull();
  });

  it("leaves already-assigned faces alone on a second run", () => {
    seed("a", [face(vectorAt(0))]);
    const first = assignUnclusteredFaces(0.45);
    const second = assignUnclusteredFaces(0.45);
    expect(second.assigned).toBe(0);
    expect(second.people).toHaveLength(first.people.length);
  });

  it("adds later faces to the cluster a user already named", () => {
    // The behaviour incremental assignment exists for: name once, and matching
    // faces found on the next pass join without further input.
    seed("a", [face(vectorAt(0))]);
    assignUnclusteredFaces(0.45);
    const personId = readPeople()[0].id;
    renamePerson(personId, "Alice");

    seed("b", [face(vectorAt(0.05))]);
    assignUnclusteredFaces(0.45);

    expect(readPeople()).toHaveLength(1);
    expect(readPeople()[0].name).toBe("Alice");
    expect(facesByPerson().get(personId)).toHaveLength(2);
  });

  it("splits a pair that a tighter threshold rejects", () => {
    // cos(0.6) ≈ 0.825 — one cluster at 0.45, two at 0.9.
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(0.6))]);
    expect(assignUnclusteredFaces(0.45).people).toHaveLength(1);

    rmSync(join(root, "app-local"), { recursive: true, force: true });
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(0.6))]);
    expect(assignUnclusteredFaces(0.9).people).toHaveLength(2);
  });

  it("processes records in a stable order", () => {
    // Incremental assignment is order-dependent by construction, so an unstable
    // record order would reshuffle the People view for no visible reason.
    const build = () => {
      rmSync(join(root, "app-local"), { recursive: true, force: true });
      seed("z", [face(vectorAt(0.3))]);
      seed("a", [face(vectorAt(0))]);
      seed("m", [face(vectorAt(0.15))]);
      assignUnclusteredFaces(0.99);
      return [...readAllFaceSidecars()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([id, s]) => `${id}:${readPeople().findIndex((p) => p.id === s.faces[0].personId)}`);
    };
    expect(build()).toEqual(build());
  });

  it("skips a face whose embedding cannot be decoded", () => {
    const broken = face(vectorAt(0));
    // Decodes to 3 bytes — not a whole number of float32s.
    broken.embedding = "AAAA";
    seed("a", [broken, face(vectorAt(1))]);
    const { assigned } = assignUnclusteredFaces(0.45);
    expect(assigned).toBe(1);
  });
});

describe("merge", () => {
  it("folds clusters together and repoints their faces", () => {
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(Math.PI / 2))]);
    assignUnclusteredFaces(0.45);
    const [first, second] = readPeople();

    expect(mergePeopleAndFaces(first.id, [second.id])).toBe(true);
    expect(readPeople()).toHaveLength(1);
    // The half a merge that touched only people.json would leave behind: a face
    // pointing at a person id that no longer exists.
    const ids = [...readAllFaceSidecars().values()].map((s) => s.faces[0].personId);
    expect(new Set(ids)).toEqual(new Set([first.id]));
    expect(readPeople()[0].faceCount).toBe(2);
  });

  it("keeps the target's name, and takes a source's if the target has none", () => {
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(Math.PI / 2))]);
    assignUnclusteredFaces(0.45);
    const [first, second] = readPeople();
    renamePerson(second.id, "Bob");

    mergePeopleAndFaces(first.id, [second.id]);
    expect(readPeople()[0].name).toBe("Bob");
  });

  it("reports an unknown target rather than silently doing nothing", () => {
    expect(mergePeopleAndFaces("no-such-person", ["also-not-real"])).toBe(false);
  });
});

describe("split", () => {
  it("moves the chosen faces into a new cluster", () => {
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(0.05))]);
    seed("c", [face(vectorAt(0.1))]);
    assignUnclusteredFaces(0.45);
    expect(readPeople()).toHaveLength(1);
    const original = readPeople()[0].id;

    const newId = splitFacesToNewPerson([{ recordId: "c", faceIndex: 0, score: 0.9 }]);
    expect(newId).not.toBeNull();
    expect(readPeople()).toHaveLength(2);
    expect(readAllFaceSidecars().get("c")!.faces[0].personId).toBe(newId);
    expect(readAllFaceSidecars().get("a")!.faces[0].personId).toBe(original);
  });

  it("removes a cluster every one of whose faces was split off", () => {
    seed("a", [face(vectorAt(0))]);
    assignUnclusteredFaces(0.45);
    const newId = splitFacesToNewPerson([{ recordId: "a", faceIndex: 0, score: 0.9 }]);
    expect(readPeople().map((p) => p.id)).toEqual([newId]);
  });

  it("returns null when none of the referenced faces exist", () => {
    expect(splitFacesToNewPerson([{ recordId: "ghost", faceIndex: 3, score: 0.9 }])).toBeNull();
  });
});

describe("reclusterAll", () => {
  it("rebuilds from scratch under a new threshold, losing the old names", () => {
    // Names cannot survive: the clusters they named no longer exist. The route
    // makes this an explicit, confirmed action for exactly that reason.
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(0.6))]);
    assignUnclusteredFaces(0.45);
    expect(readPeople()).toHaveLength(1);
    renamePerson(readPeople()[0].id, "Alice");

    const { people } = reclusterAll(0.9);
    expect(people).toHaveLength(2);
    expect(people.every((p) => p.name === "")).toBe(true);
  });
});

describe("reconcilePeopleToStore", () => {
  it("drops clusters whose every face was reaped, and keeps the rest named", () => {
    seed("keep", [face(vectorAt(0))]);
    seed("orphan", [face(vectorAt(Math.PI / 2))]);
    assignUnclusteredFaces(0.45);
    expect(readPeople()).toHaveLength(2);
    const kept = facesByPerson();
    const keptId = [...kept.keys()].find((id) => kept.get(id)![0].recordId === "keep")!;
    renamePerson(keptId, "Alice");

    reapOrphanSidecars(new Set(["keep"]));
    expect(reconcilePeopleToStore()).toBe(1);

    const people = readPeople();
    expect(people).toHaveLength(1);
    expect(people[0].id).toBe(keptId);
    expect(people[0].name).toBe("Alice");
  });

  it("recounts faceCount so the centroid keeps moving at the right rate", () => {
    // faceCount is the running-mean weight in PersonAssigner.assign, not a
    // display counter. Left inflated by reaped faces, every later face nudges
    // the centroid less than it should and the cluster stays anchored to an
    // identity whose faces are gone.
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(0.1))]);
    seed("c", [face(vectorAt(0.2))]);
    assignUnclusteredFaces(0.45);
    expect(readPeople()[0].faceCount).toBe(3);

    reapOrphanSidecars(new Set(["a"]));
    reconcilePeopleToStore();
    expect(readPeople()[0].faceCount).toBe(1);
  });

  it("re-derives the centroid from the survivors", () => {
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(0.3))]);
    assignUnclusteredFaces(0.45);

    reapOrphanSidecars(new Set(["b"]));
    reconcilePeopleToStore();
    // Exactly b's vector now — not the two-face mean it held a moment ago.
    const centroid = decodeEmbedding(readPeople()[0].centroid);
    expect(cosineSimilarity(centroid, vectorAt(0.3))).toBeCloseTo(1, 5);
  });

  it("keeps a cluster whose faces have undecodable embeddings", () => {
    // Same tolerance as PersonAssigner's constructor: one corrupt vector must
    // not silently delete a cluster the user has named.
    seed("a", [face(vectorAt(0))]);
    assignUnclusteredFaces(0.45);
    const person = readPeople()[0];
    renamePerson(person.id, "Alice");

    const sidecar = readAllFaceSidecars().get("a")!;
    sidecar.faces[0].embedding = "AAAA"; // not a whole number of float32s
    writeFaceSidecar("a", sidecar);

    expect(reconcilePeopleToStore()).toBe(0);
    const after = readPeople();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe("Alice");
    expect(after[0].faceCount).toBe(1);
    expect(after[0].centroid).toBe(person.centroid);
  });

  it("leaves a healthy store untouched", () => {
    seed("a", [face(vectorAt(0)), face(vectorAt(0.1))]);
    assignUnclusteredFaces(0.45);
    const before = readPeople();

    expect(reconcilePeopleToStore()).toBe(0);
    expect(readPeople().map((p) => ({ id: p.id, faceCount: p.faceCount }))).toEqual(
      before.map((p) => ({ id: p.id, faceCount: p.faceCount })),
    );
  });
});

describe("PersonAssigner", () => {
  it("keeps a person whose centroid cannot be decoded, but stops matching to them", () => {
    // A corrupt centroid must not cost the user a name they typed. Dropping the
    // whole file over one bad row would; dropping the row from *matching* only
    // means new faces start a fresh cluster.
    const good = newPerson(vectorAt(0));
    good.name = "Alice";
    const broken = newPerson(vectorAt(Math.PI / 2));
    broken.name = "Bob";
    broken.centroid = "AAAA"; // not a whole number of float32s

    const assigner = new PersonAssigner([good, broken], 0.45);
    // A face that would have matched Bob starts its own cluster instead...
    const assigned = assigner.assign(vectorAt(Math.PI / 2));
    expect(assigned).not.toBe(broken.id);
    // ...and Bob is still there, still named.
    expect(assigner.snapshot().find((p) => p.id === broken.id)?.name).toBe("Bob");
  });

  it("ignores a centroid of a different dimensionality", () => {
    // A model swap changes the embedding width. Comparing across it would throw
    // in the middle of a pass; skipping means those clusters simply stop
    // attracting faces until a rebuild.
    const wrongWidth = newPerson(normalize(new Float32Array([1, 0])));
    const assigner = new PersonAssigner([wrongWidth], 0.45);
    expect(() => assigner.assign(vectorAt(0))).not.toThrow();
    expect(assigner.snapshot()).toHaveLength(2);
  });

  it("reports no changes before anything is assigned", () => {
    expect(new PersonAssigner([], 0.45).hasChanges()).toBe(false);
  });

  it("grows a cluster's faceCount as faces join it", () => {
    seed("a", [face(vectorAt(0))]);
    seed("b", [face(vectorAt(0.02))]);
    seed("c", [face(vectorAt(0.04))]);
    assignUnclusteredFaces(0.45);
    expect(readPeople()).toHaveLength(1);
    // The count is what weights the centroid's running mean, so it has to track
    // membership rather than be recomputed from it.
    expect(readPeople()[0].faceCount).toBe(3);
  });
});

describe("meanEmbedding", () => {
  it("lands between its inputs and stays a unit vector", () => {
    const mean = meanEmbedding([vectorAt(0), vectorAt(Math.PI / 2)]);
    expect(cosineSimilarity(mean, vectorAt(Math.PI / 4))).toBeCloseTo(1, 5);
  });

  it("refuses an empty set rather than returning a zero vector", () => {
    expect(() => meanEmbedding([])).toThrow(/at least one/);
  });
});
