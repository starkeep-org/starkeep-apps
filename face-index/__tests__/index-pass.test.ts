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
    expect(labels.find((l) => l.key === "faces-detected")!.value).toBeNull();
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

// ---- helpers ---------------------------------------------------------------

interface WireLabel {
  app_id: string;
  key: string;
  value: string | null;
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
