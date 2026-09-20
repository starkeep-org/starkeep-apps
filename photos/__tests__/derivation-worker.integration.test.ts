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
import { STILL_LADDER } from "@/photos-lib/ladder";
import type { SweepCommand, SweepEvent } from "@/derivation/worker-protocol";

interface StoredRecord {
  id: string;
  mime_type: string;
  original_filename: string;
  parent_id: string | null;
  size_bytes: number;
  metadata: Record<string, unknown>;
}

const records = new Map<string, StoredRecord>();
/** Photos' own rendition table, keyed `<parent>\u0000<size class>`. */
const renditions = new Map<string, Record<string, unknown>>();
/** The app-private file plane: sub-key → registered row. */
const appFiles = new Map<string, { sizeBytes: number }>();
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

function rungsOf(parentId: string): Record<string, unknown>[] {
  return [...renditions.values()].filter((r) => r["parent_record_id"] === parentId);
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
    if (path === "/app-data/files/presign" && method === "POST") {
      await readBody(req);
      json(res, { url: `http://127.0.0.1:${port}/files/upload` });
      return;
    }

    // Photos' own plane. A rung is a row here and its bytes are an app-private
    // file; nothing about either is a shared record any more.
    const fileRecord = /^\/app-data\/files\/(.+)\/record$/.exec(path);
    if (fileRecord && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { sizeBytes: number };
      appFiles.set(decodeURIComponent(fileRecord[1]!), { sizeBytes: body.sizeBytes });
      json(res, { key: fileRecord[1] });
      return;
    }

    if (path === "/app-data/db/renditions") {
      if (method === "POST") {
        const body = JSON.parse(await readBody(req)) as { row: Record<string, unknown> };
        // An upsert on `(parent_record_id, size_class)`, which is the property
        // that makes a second derivation of a rung one row rather than two.
        renditions.set(`${body.row["parent_record_id"]}\u0000${body.row["size_class"]}`, body.row);
        json(res, { ok: true });
        return;
      }
      if (method === "GET") {
        const where = JSON.parse(url.searchParams.get("where") ?? "{}") as {
          parent_record_id?: { in?: string[] } | string;
        };
        const wanted = typeof where.parent_record_id === "string"
          ? [where.parent_record_id]
          : (where.parent_record_id?.in ?? []);
        json(res, {
          rows: [...renditions.values()].filter((r) =>
            wanted.includes(r["parent_record_id"] as string),
          ),
          page_token: null,
        });
        return;
      }
    }

    // Everything this node has a row for is here: it wrote the bytes itself.
    if (path === "/app-data/residency/lookup" && method === "POST") {
      const body = JSON.parse(await readBody(req)) as { subKeys: string[] };
      json(res, {
        entries: body.subKeys
          .filter((subKey) => appFiles.has(subKey))
          .map((subKey) => ({
            subKey,
            sizeBytes: appFiles.get(subKey)!.sizeBytes,
            resident: true,
            lastOpenedAtMs: null,
          })),
      });
      return;
    }

    if (path === "/app-data/residency" && method === "GET") {
      json(res, {
        budgetBytes: null,
        heldBytes: 0,
        entries: [...appFiles.entries()].map(([subKey, file]) => ({
          subKey,
          sizeBytes: file.sizeBytes,
          resident: true,
          lastOpenedAtMs: null,
        })),
        nextCursor: null,
      });
      return;
    }

    const fileUrl = /^\/data\/records\/([^/]+)\/file-url$/.exec(path);
    if (fileUrl) {
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

    if (/^\/data\/records\/[^/]+\/archive-gate$/.test(path) && method === "POST") {
      await readBody(req);
      json(res, { tagged: true, refusals: [] });
      return;
    }

    if (path === "/data/records" && method === "GET") {
      // Originals only, and no derived children to attach: the sweep asks this
      // plane for records and Photos' own table for their rungs.
      const parents = [...records.values()].filter((r) => r.parent_id === null);
      json(res, {
        records: parents.map((r) => ({
          id: r.id,
          mime_type: r.mime_type,
          availability: { state: "instant" },
          original_filename: r.original_filename,
          metadata: Object.keys(r.metadata).length > 0 ? r.metadata : null,
        })),
        nextCursor: null,
      });
      return;
    }

    if (path === "/app-data/local-files") {
      json(res, { files: [], nextCursor: null });
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
    renditions.clear();
    appFiles.clear();
    records.set("orig-1", {
      id: "orig-1",
      mime_type: "image/jpeg",
      original_filename: "photo.jpg",
      parent_id: null,
      size_bytes: sourceBytes.byteLength,
      metadata: {},
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

    // Both stages ran, so the whole applicable ladder exists — as rows in
    // Photos' own table, with bytes behind each one.
    const rungs = rungsOf("orig-1");
    expect(rungs).toHaveLength(STILL_LADDER.length);
    for (const rung of rungs) {
      expect(rung["width"]).toBeGreaterThan(0);
      expect(appFiles.has(rung["sub_key"] as string)).toBe(true);
    }
  }, 180_000);

  it("finds nothing to do on a second pass", async () => {
    // The measurement that used to be thirty seconds of saturated CPU
    // publishing zero new bytes, on every page load.
    const before = rungsOf("orig-1").length;
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
    expect(rungsOf("orig-1")).toHaveLength(before);
  }, 180_000);
});
