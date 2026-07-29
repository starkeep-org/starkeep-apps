/**
 * Clusters of faces, and the names a human puts on them.
 *
 * **Incremental assignment, not agglomerative clustering.** Each new face is
 * compared against existing cluster centroids and joins the best one above the
 * threshold, or starts its own. O(n·k) instead of O(n²) — and it is also the
 * behaviour the UX implies: name a cluster once, and faces found later join it
 * without the user doing anything.
 *
 * The split of state is deliberate:
 *   - `people.json` holds the cluster identity — id, name, centroid, size;
 *   - membership lives as `personId` on each face in its sidecar.
 * So a rename touches one small file, and nothing has to reconcile two lists of
 * the same faces.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { peoplePath } from "./paths";
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  meanEmbedding,
  updateCentroid,
} from "./embeddings";
import type { PeopleFile, Person } from "./types";

export function readPeople(): Person[] {
  try {
    const parsed = JSON.parse(readFileSync(peoplePath(), "utf-8")) as PeopleFile;
    return Array.isArray(parsed.people) ? parsed.people : [];
  } catch {
    return [];
  }
}

export function writePeople(people: Person[]): void {
  const path = peoplePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ people } satisfies PeopleFile, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function newPerson(centroid: Float32Array): Person {
  return {
    id: randomUUID(),
    name: "",
    createdAt: new Date().toISOString(),
    centroid: encodeEmbedding(centroid),
    faceCount: 1,
  };
}

/**
 * Mutable view over `people.json` for the duration of a scan.
 *
 * Holding the decoded centroids means one base64 decode per cluster per pass
 * rather than one per face-times-cluster comparison — the inner loop of the
 * whole feature.
 */
export class PersonAssigner {
  private readonly centroids = new Map<string, Float32Array>();
  private dirty = false;

  constructor(
    private readonly people: Person[],
    private readonly threshold: number,
  ) {
    for (const person of people) {
      try {
        this.centroids.set(person.id, decodeEmbedding(person.centroid));
      } catch {
        // A person whose centroid cannot be decoded can still be named and
        // displayed; it just stops attracting new faces. Dropping the whole
        // file over one bad row would lose every name the user has typed.
      }
    }
  }

  /**
   * Assign `embedding` to the closest cluster above the threshold, or create a
   * new one. Returns the person id either way — a face always belongs to
   * exactly one cluster, including a cluster of one.
   */
  assign(embedding: Float32Array): string {
    let bestId: string | null = null;
    let bestScore = this.threshold;
    for (const [id, centroid] of this.centroids) {
      if (centroid.length !== embedding.length) continue;
      const score = cosineSimilarity(centroid, embedding);
      if (score >= bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    this.dirty = true;
    if (bestId === null) {
      const person = newPerson(embedding);
      this.people.push(person);
      this.centroids.set(person.id, embedding);
      return person.id;
    }

    const person = this.people.find((p) => p.id === bestId)!;
    const updated = updateCentroid(this.centroids.get(bestId)!, person.faceCount, embedding);
    this.centroids.set(bestId, updated);
    person.centroid = encodeEmbedding(updated);
    person.faceCount += 1;
    return bestId;
  }

  /** The current roster, whether or not anything changed. */
  snapshot(): Person[] {
    return this.people;
  }

  hasChanges(): boolean {
    return this.dirty;
  }
}

/**
 * Fold `sourceIds` into `targetId`: one cluster, one name, one centroid.
 *
 * The centroid is re-derived from the merged clusters' centroids weighted by
 * size rather than by re-reading every face — which keeps merge O(k) and is
 * exact for the running means the clusters already hold.
 *
 * Callers must also rewrite the affected sidecars' `personId`; this function
 * only owns `people.json`. Returns the surviving roster, or null if `targetId`
 * is unknown.
 */
export function mergePeople(
  people: Person[],
  targetId: string,
  sourceIds: readonly string[],
): Person[] | null {
  const target = people.find((p) => p.id === targetId);
  if (!target) return null;
  const sources = people.filter((p) => p.id !== targetId && sourceIds.includes(p.id));
  if (sources.length === 0) return people;

  const members = [target, ...sources];
  const weighted: Float32Array[] = [];
  for (const person of members) {
    let centroid: Float32Array;
    try {
      centroid = decodeEmbedding(person.centroid);
    } catch {
      continue;
    }
    // Weight by size by repeating — cluster sizes here are photo-library scale,
    // and the alternative (a weighted sum) is the same arithmetic with more
    // opportunity to get the normalisation wrong.
    for (let i = 0; i < Math.max(1, person.faceCount); i++) weighted.push(centroid);
  }

  if (weighted.length > 0) target.centroid = encodeEmbedding(meanEmbedding(weighted));
  target.faceCount = members.reduce((sum, p) => sum + Math.max(0, p.faceCount), 0);
  // The target keeps its name unless it never had one, in which case the first
  // named source's name is better than nothing.
  if (!target.name) target.name = sources.find((p) => p.name)?.name ?? "";

  const removed = new Set(sources.map((p) => p.id));
  return people.filter((p) => !removed.has(p.id));
}
