/**
 * Assigning faces to people over the whole sidecar store.
 *
 * Runs *after* a pass rather than inside it, for one reason: a scan can be
 * stopped at any point, and assignment that interleaved with detection would
 * leave clusters whose centroids reflect half a library. Detection is
 * idempotent per record; assignment is a fold over all of them, so they are
 * separate steps.
 *
 * No ONNX here — this is arithmetic over stored vectors, and both the worker and
 * the routes use it.
 */

import { decodeEmbedding, meanEmbedding } from "./embeddings";
import { mergePeople, newPerson, PersonAssigner, readPeople, writePeople } from "./people";
import { readAllFaceSidecars, writeFaceSidecar } from "./sidecars";
import type { Person } from "./types";

export interface AssignmentResult {
  /** Faces that had no `personId` and now do. */
  assigned: number;
  /** Clusters after the fold. */
  people: Person[];
}

/**
 * Assign every unassigned face in the store.
 *
 * Deterministic in record order so a re-run over the same store produces the
 * same clusters: incremental assignment is order-dependent by construction (the
 * first face of a cluster defines its centroid), and an unstable order would
 * make the People view reshuffle for no visible reason.
 */
export function assignUnclusteredFaces(threshold: number): AssignmentResult {
  const sidecars = readAllFaceSidecars();
  const assigner = new PersonAssigner(readPeople(), threshold);
  let assigned = 0;

  for (const recordId of [...sidecars.keys()].sort()) {
    const sidecar = sidecars.get(recordId)!;
    let touched = false;
    for (const face of sidecar.faces) {
      if (face.personId !== null) continue;
      let embedding;
      try {
        embedding = decodeEmbedding(face.embedding);
      } catch {
        continue;
      }
      face.personId = assigner.assign(embedding);
      assigned++;
      touched = true;
    }
    if (touched) writeFaceSidecar(recordId, sidecar);
  }

  const people = assigner.snapshot();
  if (assigned > 0 || assigner.hasChanges()) writePeople(people);
  return { assigned, people };
}

/**
 * Throw away every cluster and rebuild from scratch.
 *
 * The only correct response to a threshold change: incremental assignment can
 * add faces to existing clusters but cannot un-merge two identities that a
 * looser threshold had already fused. Names are the one thing worth carrying
 * across, and they cannot be — the clusters they named no longer exist — so this
 * is a destructive operation the UI must ask about before calling.
 */
export function reclusterAll(threshold: number): AssignmentResult {
  const sidecars = readAllFaceSidecars();
  for (const [recordId, sidecar] of sidecars) {
    if (sidecar.faces.length === 0) continue;
    for (const face of sidecar.faces) face.personId = null;
    writeFaceSidecar(recordId, sidecar);
  }
  writePeople([]);
  return assignUnclusteredFaces(threshold);
}

/**
 * Merge clusters and repoint the faces that belonged to them.
 *
 * `people.ts` owns `people.json` and nothing else on purpose — the two halves of
 * a merge live in different files, and doing only the first leaves faces
 * pointing at a person id that no longer exists. This is the operation callers
 * want; `mergePeople` is the half it delegates to.
 *
 * Returns false only if the target is unknown.
 */
export function mergePeopleAndFaces(targetId: string, sourceIds: readonly string[]): boolean {
  const merged = mergePeople(readPeople(), targetId, sourceIds);
  if (!merged) return false;

  const absorbed = new Set(sourceIds.filter((id) => id !== targetId));
  for (const [recordId, sidecar] of readAllFaceSidecars()) {
    let touched = false;
    for (const face of sidecar.faces) {
      if (face.personId !== null && absorbed.has(face.personId)) {
        face.personId = targetId;
        touched = true;
      }
    }
    if (touched) writeFaceSidecar(recordId, sidecar);
  }

  writePeople(merged);
  return true;
}

/** Put a name on a cluster. Returns false if the cluster is unknown. */
export function renamePerson(personId: string, name: string): boolean {
  const people = readPeople();
  const person = people.find((p) => p.id === personId);
  if (!person) return false;
  person.name = name.trim();
  writePeople(people);
  return true;
}

export interface PersonFaceRef {
  recordId: string;
  /** Index into that sidecar's `faces` — how a single face is addressed. */
  faceIndex: number;
  score: number;
}

/** Every face belonging to each person, newest-sidecar-first within a person. */
export function facesByPerson(): Map<string, PersonFaceRef[]> {
  const out = new Map<string, PersonFaceRef[]>();
  for (const [recordId, sidecar] of readAllFaceSidecars()) {
    sidecar.faces.forEach((face, faceIndex) => {
      if (face.personId === null) return;
      const list = out.get(face.personId) ?? [];
      list.push({ recordId, faceIndex, score: face.score });
      out.set(face.personId, list);
    });
  }
  // Highest detector score first: that is the face the People view shows as the
  // cluster's cover, and the clearest one is the most useful thing to show.
  for (const list of out.values()) list.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Move specific faces out of their cluster into a new one — the "split" half of
 * the People view's merge/split.
 *
 * The new cluster's centroid is the mean of exactly the faces moved, so a split
 * that corrects a bad merge immediately stops attracting the faces it rejected.
 * Returns the new person's id, or null if nothing moved.
 */
export function splitFacesToNewPerson(refs: readonly PersonFaceRef[]): string | null {
  if (refs.length === 0) return null;
  const sidecars = readAllFaceSidecars();
  const embeddings: Float32Array[] = [];
  const byRecord = new Map<string, number[]>();

  for (const ref of refs) {
    const sidecar = sidecars.get(ref.recordId);
    const face = sidecar?.faces[ref.faceIndex];
    if (!sidecar || !face) continue;
    try {
      embeddings.push(decodeEmbedding(face.embedding));
    } catch {
      continue;
    }
    byRecord.set(ref.recordId, [...(byRecord.get(ref.recordId) ?? []), ref.faceIndex]);
  }
  if (embeddings.length === 0) return null;

  const people = readPeople();
  const person = newPerson(meanEmbedding(embeddings));
  person.faceCount = embeddings.length;
  people.push(person);

  for (const [recordId, indices] of byRecord) {
    const sidecar = sidecars.get(recordId)!;
    for (const index of indices) {
      const previous = sidecar.faces[index].personId;
      sidecar.faces[index].personId = person.id;
      const source = people.find((p) => p.id === previous);
      if (source) source.faceCount = Math.max(0, source.faceCount - 1);
    }
    writeFaceSidecar(recordId, sidecar);
  }

  // A cluster every one of whose faces was split off is gone, not empty.
  writePeople(people.filter((p) => p.id === person.id || p.faceCount > 0));
  return person.id;
}
