import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignUnclusteredFaces,
  facesByPerson,
  mergePeopleAndFaces,
  reclusterAll,
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
import { readPeople } from "@/vision/people";
import { readAllFaceSidecars, writeFaceSidecar } from "@/vision/sidecars";
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

describe("meanEmbedding", () => {
  it("lands between its inputs and stays a unit vector", () => {
    const mean = meanEmbedding([vectorAt(0), vectorAt(Math.PI / 2)]);
    expect(cosineSimilarity(mean, vectorAt(Math.PI / 4))).toBeCloseTo(1, 5);
  });

  it("refuses an empty set rather than returning a zero vector", () => {
    expect(() => meanEmbedding([])).toThrow(/at least one/);
  });
});
