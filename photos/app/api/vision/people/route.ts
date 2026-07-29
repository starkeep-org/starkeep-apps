import { type NextRequest, NextResponse } from "next/server";
import { loadAppCredentials, signedFetch } from "@starkeep/app-client";
import {
  facesByPerson,
  mergePeopleAndFaces,
  reclusterAll,
  renamePerson,
  splitFacesToNewPerson,
  type PersonFaceRef,
} from "@/vision/clustering";
import { readVisionConfig } from "@/vision/config";
import { publishFaceLabels } from "@/vision/label-publish";
import { readPeople } from "@/vision/people";
import { remoteNotImplemented } from "@/vision/remote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many member faces a cluster lists. Enough to pick from when splitting. */
const FACES_PER_PERSON = 60;

/**
 * GET /api/vision/people — clusters, largest first, each with its member faces.
 *
 * Centroids are not returned: they are averaged biometric vectors, and the
 * browser has no use for them. The People view needs an id, a name, a size, and
 * enough face references to render crops and offer a split.
 */
export async function GET(): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const members = facesByPerson();
  const people = readPeople()
    .map((person) => {
      const faces = members.get(person.id) ?? [];
      return {
        id: person.id,
        name: person.name,
        createdAt: person.createdAt,
        faceCount: faces.length,
        // Highest-scoring face first — see facesByPerson — so [0] is the crop
        // worth showing as the cluster's cover.
        faces: faces.slice(0, FACES_PER_PERSON),
      };
    })
    // Largest cluster first: it is both the most likely to be worth naming and
    // the most likely to be wrong in a way the user wants to fix.
    .sort((a, b) => b.faceCount - a.faceCount || a.createdAt.localeCompare(b.createdAt));

  return NextResponse.json({ people });
}

interface RenameBody {
  action: "rename";
  personId: string;
  name: string;
}
interface MergeBody {
  action: "merge";
  targetId: string;
  sourceIds: string[];
}
interface SplitBody {
  action: "split";
  faces: PersonFaceRef[];
}
interface ReclusterBody {
  action: "recluster";
}
type PeopleBody = RenameBody | MergeBody | SplitBody | ReclusterBody;

/**
 * PUT /api/vision/people — rename, merge, split, or rebuild the clusters.
 *
 * Every one of these changes what `photos/faces` should say, so each republishes
 * when `publishLabels` is on. Republishing computes the whole desired label
 * state and lets the set-valued write diff it, which is why a rename retracts
 * the old name rather than adding a second one beside it.
 */
export async function PUT(req: NextRequest): Promise<Response> {
  const remote = remoteNotImplemented();
  if (remote) return remote;

  const body = (await req.json().catch(() => null)) as PeopleBody | null;
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "action is required" }, { status: 400 });
  }

  switch (body.action) {
    case "rename": {
      if (!body.personId || typeof body.name !== "string") {
        return NextResponse.json({ error: "personId and name are required" }, { status: 400 });
      }
      if (!renamePerson(body.personId, body.name)) {
        return NextResponse.json({ error: "no such person" }, { status: 404 });
      }
      break;
    }
    case "merge": {
      if (!body.targetId || !Array.isArray(body.sourceIds) || body.sourceIds.length === 0) {
        return NextResponse.json(
          { error: "targetId and a non-empty sourceIds are required" },
          { status: 400 },
        );
      }
      if (!mergePeopleAndFaces(body.targetId, body.sourceIds)) {
        return NextResponse.json({ error: "no such person" }, { status: 404 });
      }
      break;
    }
    case "split": {
      if (!Array.isArray(body.faces) || body.faces.length === 0) {
        return NextResponse.json({ error: "faces must be a non-empty array" }, { status: 400 });
      }
      if (splitFacesToNewPerson(body.faces) === null) {
        return NextResponse.json({ error: "none of those faces exist" }, { status: 404 });
      }
      break;
    }
    case "recluster": {
      // Destructive: every name is lost, because the clusters they named no
      // longer exist. The UI confirms before calling this.
      reclusterAll(readVisionConfig().faces.threshold);
      break;
    }
    default:
      return NextResponse.json(
        { error: `unknown action: ${String((body as { action: unknown }).action)}` },
        { status: 400 },
      );
  }

  let warning: string | null = null;
  if (readVisionConfig().faces.publishLabels) {
    const creds = await loadAppCredentials("photos");
    if (creds) {
      try {
        await publishFaceLabels((path, init) =>
          signedFetch(creds, path, init as Parameters<typeof signedFetch>[2]),
        );
      } catch (err) {
        // The local edit succeeded and is what the user asked for; a failed
        // republish is a stale shared plane, not a lost rename.
        warning = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return GET().then(async (res) => {
    const payload = (await res.json()) as Record<string, unknown>;
    return NextResponse.json(warning ? { ...payload, warning } : payload);
  });
}
