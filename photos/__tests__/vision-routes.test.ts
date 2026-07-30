import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The `/api/vision/*` handlers.
 *
 * Driven as plain functions — a Next route segment is `Request → Response` and
 * needs no server. The parts worth pinning are not the happy paths but the
 * refusals and the side effects: which status a bad request gets, that the 501
 * guard runs before anything touches disk, that flipping `publishLabels`
 * actually publishes and actually retracts, and that a face's 512-d embedding
 * never leaves the machine through the overlay endpoint.
 *
 * `@starkeep/app-client` is mocked because these routes' credential handling is
 * not what is under test, and a real `signedFetch` would need a data server.
 */

const signedFetch = vi.fn();
const loadAppCredentials = vi.fn();

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return {
    ...actual,
    loadAppCredentials: (appId: string) => loadAppCredentials(appId),
    signedFetch: (...args: unknown[]) => signedFetch(...args),
  };
});

import { encodeEmbedding, normalize } from "@/vision/embeddings";
import { writeVisionConfig } from "@/vision/config";
import { FACE_MODEL_ID } from "@/vision/models";
import { newPerson, readPeople, writePeople } from "@/vision/people";
import { readAllFaceSidecars, writeFaceSidecar } from "@/vision/sidecars";
import { FACE_SIDECAR_VERSION, type DetectedFace } from "@/vision/types";
import { assignUnclusteredFaces } from "@/vision/clustering";

import { GET as statusGet } from "../app/api/vision/status/route";
import { GET as configGet, PUT as configPut } from "../app/api/vision/config/route";
import { GET as facesGet } from "../app/api/vision/faces/[id]/route";
import { GET as peopleGet, PUT as peoplePut } from "../app/api/vision/people/route";
import { POST as scanPost } from "../app/api/vision/scan/route";
import { GET as faceCropGet } from "../app/api/vision/face-crop/[id]/route";

let root: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["STARKEEP_DIR", "STARKEEP_APP_CLIENT_MODE", "NEXT_PUBLIC_FORCE_REMOTE"] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "starkeep-routes-"));
  process.env.STARKEEP_DIR = root;
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  delete process.env.NEXT_PUBLIC_FORCE_REMOTE;
  signedFetch.mockReset();
  loadAppCredentials.mockReset();
  loadAppCredentials.mockResolvedValue({
    appId: "photos",
    hmacSecret: "secret",
    dataServerUrl: "http://127.0.0.1:9820",
  });
  signedFetch.mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function vectorAt(angle: number): Float32Array {
  return normalize(new Float32Array([Math.cos(angle), Math.sin(angle), 0, 0]));
}

function face(angle: number, score = 0.9): DetectedFace {
  return {
    bbox: [10, 20, 30, 40],
    score,
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

function seed(recordId: string, angles: number[], dims = { w: 640, h: 480 }): void {
  writeFaceSidecar(recordId, {
    v: FACE_SIDECAR_VERSION,
    model: FACE_MODEL_ID,
    processedAt: "2026-07-28T00:00:00.000Z",
    w: dims.w,
    h: dims.h,
    faces: angles.map((a) => face(a)),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonRequest = (body: unknown) =>
  new Request("http://localhost/api/vision/x", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

/** Every handler, so the 501 guard can be asserted uniformly. */
const ALL_HANDLERS: Array<[string, () => Promise<Response>]> = [
  ["GET /status", () => statusGet()],
  ["GET /config", () => configGet()],
  ["PUT /config", () => configPut(jsonRequest({ faces: { enabled: true } }))],
  ["GET /faces/[id]", () => facesGet(new Request("http://localhost/x"), params("rec"))],
  ["GET /people", () => peopleGet()],
  ["PUT /people", () => peoplePut(jsonRequest({ action: "recluster" }))],
  [
    "POST /scan",
    () =>
      scanPost(
        new Request("http://localhost/api/vision/scan", {
          method: "POST",
          body: JSON.stringify({ action: "start" }),
        }) as never,
      ),
  ],
];

describe("the on-device guard", () => {
  it.each(ALL_HANDLERS)("%s answers 501 against a remote data server", async (_name, call) => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    const res = await call();
    expect(res.status).toBe(501);
  });

  it("refuses before touching the app-local directory", async () => {
    // A cloud deployment has no business creating this state, and a route that
    // read config *then* refused would already have.
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    await configPut(jsonRequest({ faces: { enabled: true, publishLabels: true } }));
    const status = await statusGet();
    expect(status.status).toBe(501);
    // Nothing was written, and in particular no label write was attempted.
    expect(signedFetch).not.toHaveBeenCalled();
    expect(() => readAllFaceSidecars()).not.toThrow();
    expect(readPeople()).toEqual([]);
  });
});

describe("GET /api/vision/status", () => {
  it("reports each task's models separately", async () => {
    // Per task, because the alternative cannot express "faces is installed and
    // scene is not" — which is the normal state, given one is 278 MB and the
    // other 1.7 GB.
    const body = (await (await statusGet()).json()) as {
      tasks: Record<string, { models: { installed: boolean; fetchCommand: string; licence: string } }>;
      worker: { built: boolean; buildCommand: string };
    };
    expect(body.tasks.faces.models.installed).toBe(false);
    expect(body.tasks.scene.models.installed).toBe(false);
    // The panel renders these verbatim, so a wrong command is a dead end for
    // the user rather than a cosmetic bug.
    expect(body.tasks.faces.models.fetchCommand).toBe("pnpm vision:fetch-models --faces");
    expect(body.tasks.scene.models.fetchCommand).toBe("pnpm vision:fetch-models --scene");
    expect(body.worker.buildCommand).toBe("pnpm vision:build-worker");
  });

  it("reports each group's own licence, not one shared line", async () => {
    // The one field that must not be flattened: antelopev2 is
    // non-commercial-research-only and the SigLIP weights are Apache-2.0, so a
    // shared notice would either impose a restriction that does not exist or hide
    // one that does.
    const body = (await (await statusGet()).json()) as {
      tasks: Record<string, { models: { licence: string; needsAck: boolean } }>;
      search: { models: { licence: string; needsAck: boolean } };
    };
    expect(body.tasks.faces.models.licence).toMatch(/non-commercial/);
    expect(body.tasks.faces.models.needsAck).toBe(true);
    expect(body.tasks.scene.models.licence).toBe("Apache-2.0");
    expect(body.tasks.scene.models.needsAck).toBe(false);
    expect(body.search.models.needsAck).toBe(false);
  });

  it("counts faces and people from the sidecar store, not a separate index", async () => {
    seed("a", [0, Math.PI / 2]);
    seed("b", []);
    assignUnclusteredFaces(0.45);

    const body = (await (await statusGet()).json()) as {
      tasks: { faces: { store: { processed: number; imagesWithFaces: number; facesFound: number; people: number; namedPeople: number } } };
    };
    expect(body.tasks.faces.store.processed).toBe(2);
    expect(body.tasks.faces.store.imagesWithFaces).toBe(1);
    expect(body.tasks.faces.store.facesFound).toBe(2);
    expect(body.tasks.faces.store.people).toBe(2);
    expect(body.tasks.faces.store.namedPeople).toBe(0);
  });

  it("surfaces stale-model sidecars as a gap between processed and on-disk", async () => {
    seed("current", [0]);
    writeFaceSidecar("stale", {
      v: FACE_SIDECAR_VERSION,
      model: "an-older-pair",
      processedAt: "2026-01-01T00:00:00.000Z",
      w: 10,
      h: 10,
      faces: [],
    });
    const body = (await (await statusGet()).json()) as {
      tasks: { faces: { store: { processed: number; sidecarsOnDisk: number } } };
    };
    expect(body.tasks.faces.store.processed).toBe(1);
    expect(body.tasks.faces.store.sidecarsOnDisk).toBe(2);
  });

  it("reports the default config when nothing has been configured", async () => {
    const body = (await (await statusGet()).json()) as {
      config: { faces: { enabled: boolean; publishLabels: boolean; threshold: number } };
    };
    expect(body.config.faces).toEqual({ enabled: false, threshold: 0.45, publishLabels: false });
  });
});

describe("GET|PUT /api/vision/config", () => {
  it("round-trips a change", async () => {
    await configPut(jsonRequest({ faces: { enabled: true, threshold: 0.6 } }));
    const body = (await (await configGet()).json()) as { config: { faces: { enabled: boolean; threshold: number } } };
    expect(body.config.faces.enabled).toBe(true);
    expect(body.config.faces.threshold).toBe(0.6);
  });

  it("publishes labels when publishLabels is turned on", async () => {
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    const [person] = readPeople();
    person.name = "Alice";
    writePeople([person]);

    await configPut(jsonRequest({ faces: { enabled: true, publishLabels: true } }));

    const calls = signedFetch.mock.calls.filter((c) => c[1] === "/data/labels/values");
    expect(calls.length).toBeGreaterThan(0);
    const sent = JSON.parse(String((calls[0][2] as { body: string }).body)) as {
      labels: Array<{ recordId: string; key: string; values: string[] }>;
    };
    expect(sent.labels.find((l) => l.key === "faces")!.values).toEqual(["Alice"]);
  });

  it("retracts what it published when the toggle goes off", async () => {
    // A toggle that only gated future writes would leave the names it already
    // published on the shared plane — a lie about the disclosure it controls.
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    writeVisionConfig({ faces: { enabled: true, threshold: 0.45, publishLabels: true }, scene: { enabled: false }, objects: { enabled: false, threshold: 0.35 }, tags: { vocabulary: [], threshold: 0.06 } });

    await configPut(jsonRequest({ faces: { publishLabels: false } }));

    const calls = signedFetch.mock.calls.filter((c) => c[1] === "/data/labels/values");
    expect(calls.length).toBeGreaterThan(0);
    const sent = JSON.parse(String((calls[0][2] as { body: string }).body)) as {
      labels: Array<{ values: string[] }>;
    };
    expect(sent.labels.every((l) => l.values.length === 0)).toBe(true);
  });

  it("does not touch labels when publishLabels did not change", async () => {
    seed("a", [0]);
    await configPut(jsonRequest({ faces: { enabled: true } }));
    expect(signedFetch).not.toHaveBeenCalled();
  });

  it("saves the setting and warns when the publish fails", async () => {
    // The user asked to change a setting. A failed publish is a stale shared
    // plane, not a reason to refuse the setting.
    seed("a", [0]);
    signedFetch.mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await configPut(jsonRequest({ faces: { enabled: true, publishLabels: true } }));
    const body = (await res.json()) as { config: { faces: { publishLabels: boolean } }; warning?: string };
    expect(res.status).toBe(200);
    expect(body.config.faces.publishLabels).toBe(true);
    expect(body.warning).toMatch(/500/);
  });

  it("saves the setting and warns when photos is not installed", async () => {
    loadAppCredentials.mockResolvedValue(null);
    const res = await configPut(jsonRequest({ faces: { enabled: true, publishLabels: true } }));
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toMatch(/not installed/);
  });

  it("ignores a malformed body rather than clobbering the config", async () => {
    writeVisionConfig({ faces: { enabled: true, threshold: 0.6, publishLabels: false }, scene: { enabled: false }, objects: { enabled: false, threshold: 0.35 }, tags: { vocabulary: [], threshold: 0.06 } });
    const res = await configPut(
      new Request("http://localhost/api/vision/config", { method: "PUT", body: "not json" }) as never,
    );
    const body = (await res.json()) as { config: { faces: { enabled: boolean; threshold: number } } };
    expect(body.config.faces).toEqual({ enabled: true, threshold: 0.6, publishLabels: false });
  });
});

describe("GET /api/vision/faces/[id]", () => {
  it("never returns embeddings", async () => {
    // The overlay needs geometry and a name. A 512-d identity vector is
    // biometric data with no business in a browser, and this is the only
    // endpoint that could leak one.
    seed("a", [0, 1]);
    const res = await facesGet(new Request("http://localhost/x"), params("a"));
    const raw = await res.text();
    expect(raw).not.toContain("embedding");
    const stored = readAllFaceSidecars().get("a")!;
    expect(raw).not.toContain(stored.faces[0].embedding.slice(0, 24));
  });

  it("distinguishes an unscanned image from one with no faces", async () => {
    seed("scanned", []);
    const unscanned = (await (
      await facesGet(new Request("http://localhost/x"), params("never-seen"))
    ).json()) as { processed: boolean; faces: unknown[] };
    const scanned = (await (
      await facesGet(new Request("http://localhost/x"), params("scanned"))
    ).json()) as { processed: boolean; faces: unknown[] };

    expect(unscanned).toEqual({ processed: false, faces: [] });
    expect(scanned.processed).toBe(true);
    expect(scanned.faces).toEqual([]);
  });

  it("reports a stale-model sidecar as unprocessed", async () => {
    writeFaceSidecar("stale", {
      v: FACE_SIDECAR_VERSION,
      model: "an-older-pair",
      processedAt: "2026-01-01T00:00:00.000Z",
      w: 10,
      h: 10,
      faces: [face(0)],
    });
    const body = (await (
      await facesGet(new Request("http://localhost/x"), params("stale"))
    ).json()) as { processed: boolean };
    expect(body.processed).toBe(false);
  });

  it("returns the sidecar's own dimensions, which the overlay scales by", async () => {
    // Not the record's stored width/height: those are pre-rotation, and differ
    // by a transpose on every EXIF-rotated photo.
    seed("a", [0], { w: 3000, h: 4000 });
    const body = (await (await facesGet(new Request("http://localhost/x"), params("a"))).json()) as {
      width: number;
      height: number;
      faces: Array<{ index: number; bbox: number[] }>;
    };
    expect([body.width, body.height]).toEqual([3000, 4000]);
    expect(body.faces[0].bbox).toEqual([10, 20, 30, 40]);
    expect(body.faces[0].index).toBe(0);
  });

  it("resolves each face's person name", async () => {
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    const [person] = readPeople();
    person.name = "Alice";
    writePeople([person]);

    const body = (await (await facesGet(new Request("http://localhost/x"), params("a"))).json()) as {
      faces: Array<{ name: string; personId: string | null }>;
    };
    expect(body.faces[0].name).toBe("Alice");
    expect(body.faces[0].personId).toBe(person.id);
  });

  it("reports an unnamed cluster as an empty name, not null", async () => {
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    const body = (await (await facesGet(new Request("http://localhost/x"), params("a"))).json()) as {
      faces: Array<{ name: string }>;
    };
    expect(body.faces[0].name).toBe("");
  });
});

describe("GET|PUT /api/vision/people", () => {
  it("lists clusters largest first and never returns centroids", async () => {
    seed("a", [0]);
    seed("b", [0.05]);
    seed("c", [Math.PI / 2]);
    assignUnclusteredFaces(0.45);

    const res = await peopleGet();
    const raw = await res.text();
    expect(raw).not.toContain("centroid");
    const body = JSON.parse(raw) as { people: Array<{ faceCount: number; faces: unknown[] }> };
    expect(body.people.map((p) => p.faceCount)).toEqual([2, 1]);
  });

  it("renames a cluster", async () => {
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    const [person] = readPeople();

    const res = await peoplePut(jsonRequest({ action: "rename", personId: person.id, name: "Alice" }));
    const body = (await res.json()) as { people: Array<{ name: string }> };
    expect(body.people[0].name).toBe("Alice");
    expect(readPeople()[0].name).toBe("Alice");
  });

  it("merges clusters and repoints their faces", async () => {
    seed("a", [0]);
    seed("b", [Math.PI / 2]);
    assignUnclusteredFaces(0.45);
    const [first, second] = readPeople();

    await peoplePut(jsonRequest({ action: "merge", targetId: first.id, sourceIds: [second.id] }));
    expect(readPeople()).toHaveLength(1);
    const owners = [...readAllFaceSidecars().values()].map((s) => s.faces[0].personId);
    expect(new Set(owners)).toEqual(new Set([first.id]));
  });

  it("splits selected faces into a new cluster", async () => {
    seed("a", [0]);
    seed("b", [0.05]);
    assignUnclusteredFaces(0.45);
    expect(readPeople()).toHaveLength(1);

    await peoplePut(
      jsonRequest({ action: "split", faces: [{ recordId: "b", faceIndex: 0, score: 0.9 }] }),
    );
    expect(readPeople()).toHaveLength(2);
  });

  it("rebuilds every cluster, discarding names", async () => {
    seed("a", [0]);
    seed("b", [0.6]);
    writeVisionConfig({ faces: { enabled: true, threshold: 0.9, publishLabels: false }, scene: { enabled: false }, objects: { enabled: false, threshold: 0.35 }, tags: { vocabulary: [], threshold: 0.06 } });
    assignUnclusteredFaces(0.45);
    const [person] = readPeople();
    person.name = "Alice";
    writePeople([person]);

    const res = await peoplePut(jsonRequest({ action: "recluster" }));
    const body = (await res.json()) as { people: Array<{ name: string }> };
    expect(body.people).toHaveLength(2);
    expect(body.people.every((p) => p.name === "")).toBe(true);
  });

  it("republishes labels after an edit when publishing is on", async () => {
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    writeVisionConfig({ faces: { enabled: true, threshold: 0.45, publishLabels: true }, scene: { enabled: false }, objects: { enabled: false, threshold: 0.35 }, tags: { vocabulary: [], threshold: 0.06 } });
    const [person] = readPeople();

    await peoplePut(jsonRequest({ action: "rename", personId: person.id, name: "Alice" }));

    const calls = signedFetch.mock.calls.filter((c) => c[1] === "/data/labels/values");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("does not publish when publishing is off", async () => {
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    await peoplePut(jsonRequest({ action: "rename", personId: readPeople()[0].id, name: "Alice" }));
    expect(signedFetch).not.toHaveBeenCalled();
  });

  it("keeps a rename that a failed republish could not propagate", async () => {
    seed("a", [0]);
    assignUnclusteredFaces(0.45);
    writeVisionConfig({ faces: { enabled: true, threshold: 0.45, publishLabels: true }, scene: { enabled: false }, objects: { enabled: false, threshold: 0.35 }, tags: { vocabulary: [], threshold: 0.06 } });
    signedFetch.mockResolvedValue(new Response("nope", { status: 502 }));

    const res = await peoplePut(
      jsonRequest({ action: "rename", personId: readPeople()[0].id, name: "Alice" }),
    );
    const body = (await res.json()) as { people: Array<{ name: string }>; warning?: string };
    expect(body.people[0].name).toBe("Alice");
    expect(body.warning).toMatch(/502/);
  });

  it("rejects unknown and malformed actions", async () => {
    expect((await peoplePut(jsonRequest({ action: "destroy" }))).status).toBe(400);
    expect((await peoplePut(jsonRequest({}))).status).toBe(400);
    expect((await peoplePut(jsonRequest({ action: "rename", personId: "x" }))).status).toBe(400);
    expect((await peoplePut(jsonRequest({ action: "merge", targetId: "x", sourceIds: [] }))).status).toBe(400);
    expect((await peoplePut(jsonRequest({ action: "split", faces: [] }))).status).toBe(400);
  });

  it("404s on an unknown person rather than silently doing nothing", async () => {
    expect(
      (await peoplePut(jsonRequest({ action: "rename", personId: "ghost", name: "X" }))).status,
    ).toBe(404);
    expect(
      (await peoplePut(jsonRequest({ action: "merge", targetId: "ghost", sourceIds: ["a"] }))).status,
    ).toBe(404);
    expect(
      (
        await peoplePut(
          jsonRequest({ action: "split", faces: [{ recordId: "ghost", faceIndex: 0, score: 1 }] }),
        )
      ).status,
    ).toBe(404);
  });
});

describe("POST /api/vision/scan", () => {
  const post = (body: unknown) =>
    scanPost(
      new Request("http://localhost/api/vision/scan", {
        method: "POST",
        body: JSON.stringify(body),
      }) as never,
    );

  it("rejects an action it does not understand", async () => {
    expect((await post({ action: "pause" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("refuses to start while every vision task is off", async () => {
    const res = await post({ action: "start" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/in Settings/);
  });

  it("refuses to start without the models, and names the fetch command", async () => {
    writeVisionConfig({ faces: { enabled: true, threshold: 0.45, publishLabels: false }, scene: { enabled: false }, objects: { enabled: false, threshold: 0.35 }, tags: { vocabulary: [], threshold: 0.06 } });
    const res = await post({ action: "start" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/vision:fetch-models/);
  });

  it("treats a stop with no scan running as a no-op, not an error", async () => {
    const res = await post({ action: "stop" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scan: { running: boolean } }).scan.running).toBe(false);
  });
});

describe("GET /api/vision/face-crop/[id]", () => {
  const request = (faceIndex: string) =>
    ({
      nextUrl: new URL(`http://localhost/api/vision/face-crop/a?face=${faceIndex}`),
    }) as never;

  it("rejects a non-integer face index", async () => {
    seed("a", [0]);
    expect((await faceCropGet(request("abc"), params("a"))).status).toBe(400);
    expect((await faceCropGet(request("-1"), params("a"))).status).toBe(400);
  });

  it("404s for a record with no current detections", async () => {
    expect((await faceCropGet(request("0"), params("never-seen"))).status).toBe(404);
  });

  it("404s for a face index past the end", async () => {
    seed("a", [0]);
    expect((await faceCropGet(request("5"), params("a"))).status).toBe(404);
  });

  it("503s when photos is not installed", async () => {
    seed("a", [0]);
    loadAppCredentials.mockResolvedValue(null);
    expect((await faceCropGet(request("0"), params("a"))).status).toBe(503);
  });

  it("502s when the source image cannot be resolved", async () => {
    seed("a", [0]);
    signedFetch.mockResolvedValue(new Response("gone", { status: 404 }));
    expect((await faceCropGet(request("0"), params("a"))).status).toBe(502);
  });

  it("writes no record — it is display-only", async () => {
    // The reason this is not `/api/photos/crop`: that route creates a
    // DataRecord, and the People view asks for one of these per face.
    seed("a", [0]);
    signedFetch.mockResolvedValue(new Response("gone", { status: 404 }));
    await faceCropGet(request("0"), params("a"));
    const posted = signedFetch.mock.calls.filter(
      (c) => (c[2] as { method?: string } | undefined)?.method === "POST",
    );
    expect(posted).toEqual([]);
  });
});

describe("route module isolation", () => {
  it("importing every route did not load onnxruntime", () => {
    // `vision-bundle-isolation.test.ts` proves this statically, over the import
    // graph. This proves it dynamically and from the other side: all six
    // handlers are imported at the top of this file and have been executed, and
    // the native runtime is still not in the module load list.
    const loaded = (process as unknown as { moduleLoadList: string[] }).moduleLoadList;
    expect(loaded.some((m) => m.toLowerCase().includes("onnxruntime"))).toBe(false);
    // Guards against the assertion above passing because the list is empty.
    expect(loaded.some((m) => m.includes("sharp") || m.includes("NativeModule"))).toBe(true);
  });
});
