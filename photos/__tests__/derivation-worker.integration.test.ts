/**
 * The derivation worker, running for real.
 *
 * Everything below it is unit-tested — which rungs are missing, what one
 * derivation publishes and in what order, how the controller reconciles a dead
 * pass. What none of that covers is whether the thing *starts*: the worker is a
 * separately-bundled `worker_threads` entry point, reached only by absolute
 * path, precisely so that no route can import it. That isolation is also what
 * makes it the one piece a type checker cannot vouch for. A bad import, a
 * missing external, a protocol mismatch — all of them are green everywhere else
 * and dead here.
 *
 * So this boots the real bundle in a real worker thread against a real HTTP
 * server standing in for the data plane, and asserts a cold library comes out
 * the other side with renditions. The fake server is deliberately dumb: it
 * ignores signatures and stores records in a Map. What is being tested is the
 * worker, not the broker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { workerBundlePath } from "@/derivation/sweep-controller";
import { STILL_LADDER, applicableStillClasses } from "@/photos-lib/ladder";
import type { SweepCommand, SweepEvent } from "@/derivation/worker-protocol";

interface StoredRecord {
  id: string;
  mime_type: string;
  original_filename: string;
  parent_id: string | null;
  size_bytes: number;
  metadata: Record<string, unknown>;
  /** A stand-in's role and fidelity; null on an original. */
  standIn: { role: "canonical" | "smaller"; fidelity: number } | null;
  /** An original's reported fidelity. */
  fidelity: number | null;
}

const records = new Map<string, StoredRecord>();
/** Where each original's own bytes sit, as the platform reports it. Default `here`. */
const originalPlacement = new Map<string, "here" | "cloud">();
/** Summary fields the platform reports for an original, beyond its sizes. */
const summaryFields = new Map<string, Record<string, unknown>>();
/** Every original whose bytes the worker asked for; each would be a download. */
const fileUrlCalls: string[] = [];
let sourceBytes: Buffer;
let server: Server;
let port: number;
let root: string;
let previousDir: string | undefined;
let previousMode: string | undefined;

/** Big enough that the whole ladder applies, small enough to encode quickly. */
const SOURCE_EDGE = STILL_LADDER[STILL_LADDER.length - 1]!.maxLongEdge + 200;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks as unknown as Uint8Array[]).toString("utf8")));
  });
}

function json(res: import("node:http").ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function childrenOf(parentId: string): StoredRecord[] {
  return [...records.values()].filter((r) => r.parent_id === parentId);
}

function handler(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): void {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // The original's bytes, behind the self-signed URL shape the real server
    // hands back.
    if (path === "/files/source") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(sourceBytes);
      return;
    }
    if (path === "/files/upload" && method === "PUT") {
      await readBody(req);
      json(res, { ok: true });
      return;
    }
    if (path === "/files/presign" && method === "POST") {
      await readBody(req);
      json(res, { url: `http://127.0.0.1:${port}/files/upload` });
      return;
    }

    const fileUrl = /^\/data\/records\/([^/]+)\/file-url$/.exec(path);
    if (fileUrl) {
      fileUrlCalls.push(fileUrl[1]!);
      json(res, { url: `http://127.0.0.1:${port}/files/source` });
      return;
    }

    const metaRead = /^\/data\/records\/([^/]+)\/metadata\/image$/.exec(path);
    if (metaRead && method === "GET") {
      const record = records.get(metaRead[1]!);
      const metadata = record && Object.keys(record.metadata).length > 0 ? record.metadata : null;
      json(res, { metadata });
      return;
    }

    const metaWrite = /^\/data\/records\/([^/]+)\/metadata$/.exec(path);
    if (metaWrite && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { metadata: Record<string, unknown> };
      const record = records.get(metaWrite[1]!);
      if (record) Object.assign(record.metadata, body.metadata);
      json(res, { ok: true });
      return;
    }

    const fidelityReport = /^\/data\/records\/([^/]+)\/fidelity$/.exec(path);
    if (fidelityReport && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { fidelity: number };
      const record = records.get(fidelityReport[1]!);
      if (record && record.fidelity === null) record.fidelity = body.fidelity;
      json(res, { recorded: true });
      return;
    }

    if (path === "/data/records" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        parentId: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        standIn?: { role: "canonical" | "smaller"; fidelity: number };
        parentFidelity?: number;
      };
      // One stand-in per size per original, as the platform's slot index keeps
      // it: a second encode of a size is refused and the existing one named.
      const existing = childrenOf(body.parentId).find(
        (c) => c.standIn && body.standIn && c.standIn.fidelity === body.standIn.fidelity,
      );
      if (existing) {
        json(res, { error: "StandInExists", existing: existing.id }, 409);
        return;
      }
      const parent = records.get(body.parentId);
      if (parent && parent.fidelity === null && body.parentFidelity) parent.fidelity = body.parentFidelity;
      const id = `child-${records.size}`;
      records.set(id, {
        id,
        mime_type: body.contentType,
        original_filename: body.fileName,
        parent_id: body.parentId,
        size_bytes: body.sizeBytes,
        metadata: {},
        standIn: body.standIn ?? null,
        fidelity: null,
      });
      json(res, { record: { id } });
      return;
    }

    if (path === "/data/records" && method === "GET") {
      // Photos asks two existence questions of one original: its stand-ins, by
      // role, and its derived records, by label. Honouring them is not
      // optional detail: a fake that ignored them would report every record as
      // underived and the sweep would look like it worked while re-deriving
      // everything.
      const where = url.searchParams.get("where");
      const parentId = where === null
        ? null
        : ((JSON.parse(where) as { parent_id?: string }).parent_id ?? null);
      if (parentId !== null) {
        const standIns = where!.includes("stand_in_role");
        json(res, {
          records: childrenOf(parentId)
            .filter((c) => (standIns ? c.standIn !== null : c.standIn === null))
            .map((c) => ({
              type: "image/avif",
              stand_in_role: c.standIn?.role ?? null,
              fidelity: c.standIn?.fidelity ?? null,
              labels: [],
            })),
        });
        return;
      }

      // The sweep's listing: originals only, each carrying the platform's size
      // summary of its stand-ins.
      const parents = [...records.values()].filter((r) => r.parent_id === null);
      json(res, {
        records: parents.map((r) => ({
          id: r.id,
          mime_type: r.mime_type,
          original_filename: r.original_filename,
          size_bytes: r.size_bytes,
          fidelity: r.fidelity,
          metadata: Object.keys(r.metadata).length > 0 ? r.metadata : null,
          stand_ins: {
            category: "image",
            fidelity: r.fidelity,
            status: r.fidelity === null ? "fidelity-unknown" : "archivable",
            top: r.fidelity === null ? null : 4272,
            sizes: childrenOf(r.id)
              .filter((c) => c.standIn !== null)
              .map((c) => ({
                fidelity: c.standIn!.fidelity,
                role: c.standIn!.role,
                record_id: c.id,
                type: "image/avif",
                size_bytes: c.size_bytes,
                placement: "here",
              })),
            original_placement: originalPlacement.get(r.id) ?? "here",
            ...(summaryFields.get(r.id) ?? {}),
          },
        })),
        nextCursor: null,
      });
      return;
    }

    json(res, { error: `unexpected ${method} ${path}` }, 404);
  })();
}

/** Run one sweep in the real worker bundle and resolve when it finishes. */
function runWorker(command: SweepCommand): Promise<SweepEvent> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerBundlePath());
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("the worker never finished"));
    }, 120_000);
    worker.on("message", (event: SweepEvent) => {
      if (event.type === "finished" || event.type === "failed") {
        clearTimeout(timer);
        resolve(event);
      }
    });
    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.postMessage(command);
  });
}

beforeAll(async () => {
  sourceBytes = await sharp({
    create: {
      width: SOURCE_EDGE,
      height: Math.round(SOURCE_EDGE * 0.75),
      channels: 3,
      background: { r: 120, g: 90, b: 40 },
    },
  })
    // IFD2 is the Exif IFD as sharp names it. Present so the assertion below
    // covers EXIF extraction *inside the bundled worker*, which is where a
    // library that loses its capture dates would actually lose them.
    .withExif({ IFD2: { DateTimeOriginal: "2019:04:02 11:30:00" } })
    .jpeg({ quality: 60 })
    .toBuffer();

  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;

  root = mkdtempSync(join(tmpdir(), "starkeep-derive-e2e-"));
  previousDir = process.env.STARKEEP_DIR;
  previousMode = process.env.STARKEEP_APP_CLIENT_MODE;
  process.env.STARKEEP_DIR = root;
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  mkdirSync(join(root, "app-creds"), { recursive: true });
  writeFileSync(
    join(root, "app-creds", "photos.json"),
    JSON.stringify({
      appId: "photos",
      hmacSecret: "sweep-integration-secret",
      dataServerUrl: `http://127.0.0.1:${port}`,
    }),
  );
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousDir === undefined) delete process.env.STARKEEP_DIR;
  else process.env.STARKEEP_DIR = previousDir;
  if (previousMode !== undefined) process.env.STARKEEP_APP_CLIENT_MODE = previousMode;
  rmSync(root, { recursive: true, force: true });
});

describe("a cold library, swept by the real worker", () => {
  it("derives it without anyone opening the app", async () => {
    // This is the case the whole phase exists for: a bulk copy into a watched
    // folder, with no browser tab anywhere.
    if (!existsSync(workerBundlePath())) {
      throw new Error("run `pnpm derive:build-worker` before this test");
    }
    records.clear();
    records.set("orig-1", {
      id: "orig-1",
      mime_type: "image/jpeg",
      original_filename: "photo.jpg",
      parent_id: null,
      size_bytes: sourceBytes.byteLength,
      metadata: {},
      standIn: null,
      fidelity: null,
    });

    const event = await runWorker({
      type: "start",
      resume: { stage: "cheap", cursor: null },
      concurrency: 2,
    });
    expect(event.type, event.type === "failed" ? event.message : undefined).toBe("finished");

    // The placeholder and the record's own facts, from the decode that was
    // happening anyway. Without `captured_at` a watched-folder import files an
    // entire library under its import date.
    const parent = records.get("orig-1")!;
    expect(parent.metadata.thumb_hash).toBeTypeOf("string");
    expect(parent.metadata.width).toBe(SOURCE_EDGE);
    // Without this, a watched-folder import files an entire library under its
    // import date and then silently reorders as photos are opened one by one.
    expect(new Date(parent.metadata.captured_at as string).getFullYear()).toBe(2019);

    // Both stages ran, so every stand-in this original takes exists — which,
    // for a flat fixture under the platform's size floor, is every standard
    // size and no canonical stand-in.
    const expected = applicableStillClasses(SOURCE_EDGE, sourceBytes.byteLength);
    expect(childrenOf("orig-1")).toHaveLength(expected.length);
    expect(childrenOf("orig-1").map((c) => c.standIn!.fidelity).sort((a, b) => a - b)).toEqual(
      expected.map((spec) => spec.maxLongEdge),
    );
    // And the platform learned the original's fidelity from the first write.
    expect(parent.fidelity).toBe(SOURCE_EDGE);
  }, 180_000);

  it("finds nothing to do on a second pass", async () => {
    // The measurement that used to be thirty seconds of saturated CPU
    // publishing zero new bytes, on every page load.
    const before = childrenOf("orig-1").length;
    const event = await runWorker({
      type: "start",
      resume: { stage: "cheap", cursor: null },
      concurrency: 2,
    });
    expect(event.type).toBe("finished");
    if (event.type === "finished") {
      expect(event.state.derived).toBe(0);
      expect(event.state.skipped).toBeGreaterThan(0);
    }
    expect(childrenOf("orig-1")).toHaveLength(before);
  }, 180_000);
});

describe("a machine with downloads to derive turned off", () => {
  const configPath = () => join(root, "app-local", "photos", "derivation", "config.json");

  it("derives only from originals already here, and still reports a cloud-only original's fidelity", async () => {
    if (!existsSync(workerBundlePath())) {
      throw new Error("run `pnpm derive:build-worker` before this test");
    }
    mkdirSync(join(root, "app-local", "photos", "derivation"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ downloadOriginalsToDerive: false }));
    try {
      records.clear();
      originalPlacement.clear();
      fileUrlCalls.length = 0;
      const stored = (id: string): StoredRecord => ({
        id,
        mime_type: "image/jpeg",
        original_filename: `${id}.jpg`,
        parent_id: null,
        size_bytes: sourceBytes.byteLength,
        // Dimensions already known, as a synced original's are.
        metadata: { width: SOURCE_EDGE, height: Math.round(SOURCE_EDGE * 0.75), thumb_hash: "x" },
        standIn: null,
        fidelity: null,
      });
      records.set("orig-here", stored("orig-here"));
      records.set("orig-cloud", stored("orig-cloud"));
      originalPlacement.set("orig-cloud", "cloud");

      const event = await runWorker({
        type: "start",
        resume: { stage: "cheap", cursor: null },
        concurrency: 2,
      });
      expect(event.type, event.type === "failed" ? event.message : undefined).toBe("finished");

      // Any read of the cloud-only original would have downloaded it.
      expect(fileUrlCalls).not.toContain("orig-cloud");
      expect(childrenOf("orig-cloud")).toEqual([]);
      // The fidelity needs no bytes, so it is reported anyway.
      expect(records.get("orig-cloud")!.fidelity).toBe(SOURCE_EDGE);

      // The original that is here is still derived.
      expect(fileUrlCalls).toContain("orig-here");
      expect(childrenOf("orig-here").length).toBeGreaterThan(0);
    } finally {
      rmSync(configPath(), { force: true });
    }
  }, 120_000);
});

describe("a lowered threshold, replaced on a machine that does not download", () => {
  const configPath = () => join(root, "app-local", "photos", "derivation", "config.json");

  it("makes the new canonical stand-in from the current one and never fetches the original", async () => {
    if (!existsSync(workerBundlePath())) {
      throw new Error("run `pnpm derive:build-worker` before this test");
    }
    mkdirSync(join(root, "app-local", "photos", "derivation"), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ downloadOriginalsToDerive: false }));
    try {
      records.clear();
      originalPlacement.clear();
      summaryFields.clear();
      fileUrlCalls.length = 0;
      records.set("orig-lowered", {
        id: "orig-lowered",
        mime_type: "image/jpeg",
        original_filename: "lowered.jpg",
        parent_id: null,
        size_bytes: sourceBytes.byteLength,
        metadata: { width: SOURCE_EDGE, height: Math.round(SOURCE_EDGE * 0.75), thumb_hash: "x", exif_present: false },
        standIn: null,
        fidelity: SOURCE_EDGE,
      });
      originalPlacement.set("orig-lowered", "cloud");
      // Every size the original takes under its new stamp, and a canonical
      // stand-in made at the old 4272.
      for (const fidelity of [320, 640, 1280]) {
        records.set(`small-${fidelity}`, {
          id: `small-${fidelity}`,
          mime_type: "image/avif",
          original_filename: `small-${fidelity}`,
          parent_id: "orig-lowered",
          size_bytes: 1000,
          metadata: {},
          standIn: { role: "smaller", fidelity },
          fidelity: null,
        });
      }
      records.set("old-canonical", {
        id: "old-canonical",
        mime_type: "image/avif",
        original_filename: "old-canonical",
        parent_id: "orig-lowered",
        size_bytes: 1000,
        metadata: {},
        standIn: { role: "canonical", fidelity: 4272 },
        fidelity: null,
      });
      summaryFields.set("orig-lowered", { canonical_target: 2560, canonical_outdated: true, top: 4272 });

      const event = await runWorker({
        type: "start",
        resume: { stage: "full", cursor: null },
        concurrency: 1,
      });
      expect(event.type, event.type === "failed" ? event.message : undefined).toBe("finished");

      expect(fileUrlCalls).not.toContain("orig-lowered");
      expect(fileUrlCalls).toContain("old-canonical");
      const canonicals = childrenOf("orig-lowered").filter((c) => c.standIn?.role === "canonical");
      expect(canonicals.map((c) => c.standIn!.fidelity).sort((a, b) => a - b)).toEqual([2560, 4272]);
    } finally {
      rmSync(configPath(), { force: true });
    }
  }, 120_000);
});
