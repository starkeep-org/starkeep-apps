/**
 * End-to-end data-path integration: real client → real signing route → data
 * server, in one process.
 *
 * This is the test that would have caught the reinstall failure at the code
 * level. It wires the ACTUAL pieces together:
 *
 *   listPhotos()                                (src/lib/data-server-client)
 *     → GET /api/photos/library                 (app/api/photos/library/route)
 *         loads on-disk creds, HMAC-signs, forwards to the data server, and
 *         returns base records and the server-owned threshold policies
 *     → a fake data server that REJECTS any request lacking a valid
 *       X-Starkeep-App-{Id,Sig,Ts} signature — exactly like the cloud data
 *       server, whose 401 "Missing X-Starkeep-App headers" started all this.
 *
 * `fetch` is stubbed to dispatch both hops (browser→route and route→data
 * server) in-process, so no servers or AWS are involved. If anyone reintroduces
 * a direct-to-gateway data path (dropping the signing hop), the request arrives
 * at the fake server unsigned and the test fails with the same 401 the user saw.
 *
 * The generic proxy is still mounted for everything else and is exercised here
 * too, because `getPhotoFileUrls` and friends go through it unchanged.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAppCredentialsCache, createDataProxyHandler } from "@starkeep/app-client";
import { GET as libraryRoute } from "../src/routes/photos/library";
import { LIBRARY_ORDER } from "../src/photos-lib/capture-order";
import { POST as renditionsRoute } from "../src/routes/photos/renditions";
import { listPhotos, listPhotosSince, requestOwnApi } from "../src/lib/data-server-client";
import { canonicalTarget, currentRenditionPolicies } from "../src/photos-lib/rendition-policy";

const HMAC_SECRET = "integration-test-secret";
const DATA_SERVER_URL = "http://fake-data-server.test";

let dir: string;
let realFetch: typeof fetch;
/** Requests the fake data server received, for signature assertions. */
let received: Array<{ path: string; headers: Record<string, string | null> }>;
/** Records the fake data server will return from GET /data/records. */
const seededRecords: unknown[] = [{ id: "rec-1", type: "image/png", original_filename: "a.png" }];

// Mirrors the app's own mount: local mode, no end-user gate. See the route at
// app/api/local-data/[...path]/route.ts for why that answer is what it is.
const proxyHandler = createDataProxyHandler({
  appId: "photos",
  endUserAuth: { auth: "anonymous", justification: "matches the app's current mount" },
});

const defaultSeededRecord = { id: "rec-1", type: "image/png", original_filename: "a.png" };

/** Rows the fake server will return from Photos' own rendition table. */
const seededRenditions: unknown[] = [];

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Minimal fake cloud-data-server: HMAC-gates, then serves GET /data/records. */
async function fakeDataServer(url: URL, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers as HeadersInit);
  const appId = headers.get("x-starkeep-app-id");
  const sig = headers.get("x-starkeep-app-sig");
  const ts = headers.get("x-starkeep-app-ts");
  received.push({
    path: url.pathname + url.search,
    headers: { appId, sig, ts },
  });
  // The gate that produced the user's 401.
  if (!appId || !sig || !ts) {
    return new Response(
      JSON.stringify({ error: "Missing X-Starkeep-App-{Id,Sig,Ts} headers" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  if (method === "GET" && url.pathname === "/data/records") {
    return new Response(JSON.stringify({ records: seededRecords }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  // Photos' own plane. A rung is a row here and its bytes are an app-private
  // file — nothing about either reaches `/data/records` any more.
  if (method === "GET" && url.pathname === "/app-data/db/renditions") {
    return json({ rows: seededRenditions, page_token: null });
  }
  if (method === "POST" && url.pathname === "/app-data/residency/lookup") {
    const asked = JSON.parse(String(init.body)) as { subKeys: string[] };
    return json({
      entries: asked.subKeys.map((subKey) => ({
        subKey,
        sizeBytes: 1000,
        resident: true,
        lastOpenedAtMs: null,
      })),
    });
  }
  if (method === "POST" && url.pathname === "/app-data/file-urls") {
    const asked = JSON.parse(String(init.body)) as { subKeys: string[] };
    // Opaque, as the local server's token URLs are. A presigned S3 URL does
    // carry its object key, and an object key for a rung carries the rung's
    // name — which is why the "no size class in consumers" rule below is about
    // the response's own fields rather than about every byte of every URL.
    return json({
      urls: Object.fromEntries(
        asked.subKeys.map((subKey, index) => [subKey, `https://files.test/token-${index}`]),
      ),
      expiresIn: 3600,
    });
  }
  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
}

/** Dispatches the two hops: browser→proxy (/api/local-data) and proxy→server. */
async function dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input.toString();

  if (rawUrl.startsWith(DATA_SERVER_URL)) {
    return fakeDataServer(new URL(rawUrl), init ?? {});
  }

  // Same-origin browser call → run it through the real route handler.
  const url = new URL(rawUrl, "http://app.local");
  if (url.pathname === "/api/photos/library") {
    return libraryRoute({
      url: `http://app.local${url.pathname}${url.search}`,
      headers: new Headers(init?.headers as HeadersInit),
    } as never);
  }
  if (url.pathname === "/api/photos/renditions") {
    return renditionsRoute({
      url: `http://app.local${url.pathname}${url.search}`,
      headers: new Headers(init?.headers as HeadersInit),
      json: async () => JSON.parse(String(init?.body)),
    } as never);
  }
  if (url.pathname.startsWith("/api/local-data/")) {
    const segments = url.pathname.slice("/api/local-data/".length).split("/");
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText =
      init?.body != null ? String(init.body as string) : "";
    const nextReq = {
      method,
      url: `http://app.local${url.pathname}${url.search}`,
      headers: { get: (n: string) => new Headers(init?.headers as HeadersInit).get(n) },
      text: async () => bodyText,
      arrayBuffer: async () => new TextEncoder().encode(bodyText).buffer,
    };
    return proxyHandler(nextReq, { params: Promise.resolve({ path: segments }) });
  }

  throw new Error(`unexpected fetch to ${rawUrl}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "photos-cloud-path-"));
  process.env.STARKEEP_DIR = dir;
  mkdirSync(join(dir, "app-creds"), { recursive: true });
  writeFileSync(
    join(dir, "app-creds", "photos.json"),
    JSON.stringify({ appId: "photos", hmacSecret: HMAC_SECRET, dataServerUrl: DATA_SERVER_URL }),
  );
  clearAppCredentialsCache();
  seededRecords.splice(0, seededRecords.length, defaultSeededRecord);
  received = [];
  realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", dispatchFetch as unknown as typeof fetch);
});

afterEach(() => {
  vi.stubGlobal("fetch", realFetch);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STARKEEP_DIR;
  clearAppCredentialsCache();
});

describe("cloud data path (client → proxy → data server)", () => {
  it("listPhotos reaches the data server with a valid HMAC signature and returns records", async () => {
    const records = await listPhotos();

    // The initial record is base/layout data only. Resolution is a separate
    // measured POST once a component is near-visible.
    expect(records.map((r) => r.id)).toEqual(seededRecords.map((r) => (r as { id: string }).id));
    expect(records[0]?.renditions).toBeUndefined();

    // The data server saw exactly the request the user's session 401'd on...
    const dataReq = received.find((r) => r.path.startsWith("/data/records"));
    expect(dataReq, "no /data/records request reached the data server").toBeTruthy();
    // include=metadata rides along (and is HMAC-signed) through the proxy so
    // the list arrives enriched with per-record dimensions/EXIF.
    // Asserted by parts rather than as one string so unrelated query tuning
    // does not make the integration brittle.
    const params = new URLSearchParams(dataReq!.path.split("?")[1]);
    expect(params.get("include")).toBe("metadata,labels");
    // Capture order, which is what makes a page of the library a slice of it
    // rather than whichever records sort first by content-addressed id. The
    // grid mirrors this key — see `photos-lib/capture-order.ts`.
    expect(params.get("order")).toBe(LIBRARY_ORDER);
    // Renditions are excluded server-side — a page mixing them with originals
    // is a page the client cannot page through.
    expect(params.get("notLabel")).toBe("photos/rendition");
    expect(params.get("variant")).toBeNull();
    expect(params.get("variantLongEdge")).toBeNull();
    expect(params.get("targets")).toBeNull();
    // ...but now signed, because it went through the proxy rather than direct.
    expect(dataReq!.headers.appId).toBe("photos");
    expect(dataReq!.headers.sig).toBeTruthy();
    expect(Number.isFinite(Number(dataReq!.headers.ts))).toBe(true);
  });

  // A delta is walked by sync time and the library by capture time, so the two
  // requests cannot share an ordering. The delta's own key is `updated_at`
  // ascending, which is what makes a page a prefix of the changed set and the
  // maximum `updated_at` in it a safe watermark. Capture order would hand back
  // the most recently photographed of the changes; the route's old default,
  // `id asc`, had the same defect in a different key.
  it("cuts an incremental delta in updated_at order, not the library's", async () => {
    await listPhotosSince("2026-09-01T00:00:00.000Z");
    const delta = received.filter((r) => r.path.includes("updated_after")).at(-1);
    expect(delta, "no delta request reached the data server").toBeTruthy();
    const params = new URLSearchParams(delta!.path.split("?")[1]);
    expect(params.get("updated_after")).toBe("2026-09-01T00:00:00.000Z");
    expect(params.get("order")).toBe("updated_at.asc");
    expect(params.get("order")).not.toBe(LIBRARY_ORDER);
  });

  it("the fake server proves an unsigned request would 401 (regression canary)", async () => {
    // Sanity-check the gate itself: a direct, unsigned call reproduces the
    // original failure — so the passing test above is meaningful.
    const res = await fakeDataServer(new URL(`${DATA_SERVER_URL}/data/records?limit=500`), {
      method: "GET",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Missing X-Starkeep-App/);
  });

  it("does not load candidate children during the initial library request", async () => {
    seededRecords.splice(0, seededRecords.length, {
      id: "rec-with-stale-child",
      type: "image/jpeg",
      mime_type: "image/jpeg",
      original_filename: "photo.jpg",
      metadata: { width: 4000, height: 3000 },
    });

    const [record] = await listPhotos();

    expect(record?.renditions).toBeUndefined();
    const params = new URLSearchParams(received.find((r) => r.path.startsWith("/data/records"))!.path.split("?")[1]);
    expect(params.get("variant")).toBeNull();
    // And the library page asks Photos' own plane nothing either: the grid
    // paints from ThumbHashes and resolves rungs in a second, batched call.
    expect(received.some((r) => r.path.startsWith("/app-data/"))).toBe(false);
  });

  it("resolves a visible record through one signed canonical batch lookup", async () => {
    seededRecords.splice(0, seededRecords.length, {
      id: "rec-visible",
      type: "image/jpeg",
      mime_type: "image/jpeg",
      original_filename: "visible.jpg",
      metadata: { width: 4000, height: 3000 },
    });
    seededRenditions.splice(0, seededRenditions.length, {
      parent_record_id: "rec-visible",
      size_class: "image-medium",
      sub_key: "renditions/rec-visible/image-medium/mediumhash.webp",
      content_hash: "mediumhash",
      width: 1280,
      height: 960,
      size_bytes: 40_000,
      content_type: "image/webp",
    });

    const body = await requestOwnApi<{
      results: Array<Record<string, unknown>>;
    }>("/api/photos/renditions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{
        recordId: "rec-visible",
        policyVersion: "stale-policy",
        // A requirement inside the medium rung's range, paired with a target
        // from a policy that no longer exists. The server recanonicalizes the
        // requirement and ignores the stale target.
        requiredLongEdge: 700,
        targetLongEdge: 400,
      }] }),
    });

    // One shared-plane request for the source's dimensions, and three against
    // Photos' own plane: the rows, this node's bytes, and the URLs. Each is a
    // different owner's answer, and the platform holds no joined view of them.
    const sharedCalls = received.filter((r) => r.path.startsWith("/data/records"));
    expect(sharedCalls).toHaveLength(1);
    expect(received.filter((r) => r.path.startsWith("/app-data/"))).toHaveLength(4);
    const upstream = sharedCalls[0]!;
    const params = new URLSearchParams(upstream.path.split("?")[1]);
    expect(JSON.parse(params.get("where")!)).toEqual({ id: { in: ["rec-visible"] } });
    expect(params.get("include")).toBe("metadata");
    expect(params.get("variant")).toBeNull();
    expect(upstream.headers.appId).toBe("photos");
    // Every hop is signed, including the app-private ones.
    for (const call of received) expect(call.headers.sig).toBeTruthy();
    expect(upstream.headers.sig).toBeTruthy();
    expect(body.results[0]).toMatchObject({
      recordId: "rec-visible",
      status: "resolved",
      policyVersion: currentRenditionPolicies().still.version,
      canonicalTargetLongEdge: canonicalTarget(currentRenditionPolicies().still, 700),
    });
    expect(JSON.stringify(body)).not.toContain("image-medium");
  });
});
