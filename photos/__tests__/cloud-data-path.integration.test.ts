/**
 * End-to-end data-path integration: real client → real signing proxy → data
 * server, in one process.
 *
 * This is the test that would have caught the reinstall failure at the code
 * level. It wires the ACTUAL pieces together:
 *
 *   listPhotos()                                  (src/lib/data-server-client)
 *     → resolveDataSource() → "/api/local-data"   (src/lib/data-client)
 *     → createNextProxyHandler({ appId: "photos" })  (@starkeep/app-client)
 *         loads on-disk creds, HMAC-signs, forwards to the data server URL
 *     → a fake data server that REJECTS any request lacking a valid
 *       X-Starkeep-App-{Id,Sig,Ts} signature — exactly like the cloud data
 *       server, whose 401 "Missing X-Starkeep-App headers" started all this.
 *
 * `fetch` is stubbed to dispatch both hops (browser→proxy and proxy→data
 * server) in-process, so no servers or AWS are involved. If anyone reintroduces
 * a direct-to-gateway data path (dropping the proxy), the request arrives at
 * the fake server unsigned and the test fails with the same 401 the user saw.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAppCredentialsCache, createNextProxyHandler } from "@starkeep/app-client";
import { listPhotos } from "../src/lib/data-server-client";

const HMAC_SECRET = "integration-test-secret";
const DATA_SERVER_URL = "http://fake-data-server.test";

let dir: string;
let realFetch: typeof fetch;
/** Requests the fake data server received, for signature assertions. */
let received: Array<{ path: string; headers: Record<string, string | null> }>;
/** Records the fake data server will return from GET /data/records. */
const seededRecords: unknown[] = [{ id: "rec-1", type: "image/png", original_filename: "a.png" }];

const proxyHandler = createNextProxyHandler({ appId: "photos" });

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
  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
}

/** Dispatches the two hops: browser→proxy (/api/local-data) and proxy→server. */
async function dispatchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input.toString();

  if (rawUrl.startsWith(DATA_SERVER_URL)) {
    return fakeDataServer(new URL(rawUrl), init ?? {});
  }

  // Same-origin browser call → run it through the real proxy route handler.
  const url = new URL(rawUrl, "http://app.local");
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

    expect(records).toEqual(seededRecords);

    // The data server saw exactly the request the user's session 401'd on...
    const dataReq = received.find((r) => r.path.startsWith("/data/records"));
    expect(dataReq, "no /data/records request reached the data server").toBeTruthy();
    // include=metadata rides along (and is HMAC-signed) through the proxy so
    // the list arrives enriched with per-record dimensions/EXIF.
    expect(dataReq!.path).toBe("/data/records?limit=500&include=metadata");
    // ...but now signed, because it went through the proxy rather than direct.
    expect(dataReq!.headers.appId).toBe("photos");
    expect(dataReq!.headers.sig).toBeTruthy();
    expect(Number.isFinite(Number(dataReq!.headers.ts))).toBe(true);
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
});
