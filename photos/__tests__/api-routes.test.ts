/**
 * Which path and method reaches which handler.
 *
 * Gap 1 of the plan's section 3.4: three of twenty-two handlers were tested at
 * the HTTP boundary, and the migration rerouted every one of them. The route
 * table used to be a directory tree the framework read, so "does `/api/photos/
 * cover` reach cover.ts" was a question about file layout and nobody had to ask
 * it. It is a list of `app.get(...)` calls now, and a wrong one is a 404 or —
 * worse — a handler answering a path that belongs to another.
 *
 * Driven through the real Hono app, with the platform's credential loading and
 * signing mocked. The point is the HTTP shape, not the data plane: a handler
 * that was reached says so by answering something other than the router's own
 * 404, and the mocked `signedFetch` records what it would have asked upstream.
 *
 * The two `:id` routes are the ones worth the most attention. Hono matches a
 * static segment ahead of a parameter, but `/api/photos/cover` and
 * `/api/photos/:id` are the same shape, and a router that got that backwards
 * would treat "cover" as a record id and answer 404 for a file that exists.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { app } from "@/server-app";

const ORIGIN = "http://photos.test";
const DATA_SERVER = "http://data.test";

/**
 * A real credential on disk, because the signing proxy loads one that the mock
 * above cannot reach. `createNextProxyHandler` lives inside
 * `@starkeep/app-client` and calls the package's *internal*
 * `loadAppCredentials`, so mocking the re-exported name intercepts Photos' own
 * routes and nothing the platform does behind them.
 *
 * `STARKEEP_DIR` is pointed at a throwaway directory by `vitest.config.ts`, so
 * this writes nowhere near the operator's own state.
 */
beforeAll(() => {
  const credsDir = join(process.env.STARKEEP_DIR!, "app-creds");
  mkdirSync(credsDir, { recursive: true });
  writeFileSync(
    join(credsDir, "photos.json"),
    JSON.stringify({ appId: "photos", hmacSecret: "test-secret", dataServerUrl: DATA_SERVER }),
  );
});

/** The upstream path the mocked `signedFetch` was asked for, if any. */
function upstreamPaths(): string[] {
  return signedFetch.mock.calls.map((c) => String(c[1]));
}

/**
 * What the signing proxy forwarded. It signs and calls the global `fetch`
 * rather than `signedFetch`, so its destination is observed here — and stubbing
 * the global is also what keeps a unit test from resolving `data.test` against
 * real DNS.
 */
let forwarded: string[] = [];

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return app.fetch(new Request(`${ORIGIN}${path}`, init));
}

beforeEach(() => {
  vi.stubEnv("STARKEEP_APP_CLIENT_MODE", "");
  signedFetch.mockReset();
  loadAppCredentials.mockReset();
  loadAppCredentials.mockResolvedValue({
    appId: "photos",
    hmacSecret: "test-secret",
    dataServerUrl: DATA_SERVER,
  });
  // Every upstream call answers one body that satisfies every caller's shape,
  // so a handler that was reached runs to completion rather than throwing part
  // way through on a field the mock did not supply. Routing is what is under
  // test; the contents are not.
  //
  // A fresh `Response` per call, not one shared instance: a body can only be
  // read once, and a handler making two upstream calls would see the second
  // fail with "Body is unusable" rather than the shape it asked for.
  signedFetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          records: [],
          rows: [],
          url: "http://upload.test/put",
          record: { id: "rec1", type: "image/jpeg", parent_id: null, object_storage_key: null },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  forwarded = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    forwarded.push(typeof input === "string" ? input : input.toString());
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * Every route the app mounts, as (method, path) and the fact that proves it was
 * reached. `notFound` is the router's own answer, so "not that" is the whole
 * assertion for a handler whose body needs a data plane.
 */
const ROUTES: ReadonlyArray<[string, string]> = [
  ["GET", "/starkeep-runtime-config"],
  ["GET", "/api/session"],
  ["GET", "/api/photos/library"],
  ["POST", "/api/photos/renditions"],
  ["POST", "/api/photos/crop"],
  ["GET", "/api/photos/cover"],
  ["PUT", "/api/photos/cover"],
  ["DELETE", "/api/photos/cover"],
  ["GET", "/api/photos/style-graphic"],
  ["PUT", "/api/photos/style-graphic"],
  ["DELETE", "/api/photos/style-graphic"],
  ["GET", "/api/photos/captions/rec1"],
  ["PUT", "/api/photos/captions/rec1"],
  ["DELETE", "/api/photos/captions/rec1"],
  ["GET", "/api/photos/rec1"],
  ["PATCH", "/api/photos/rec1"],
  ["DELETE", "/api/photos/rec1"],
  ["POST", "/api/resize"],
  ["POST", "/api/share"],
  ["POST", "/api/local-sync-handoff"],
  ["GET", "/api/derive/status"],
  ["POST", "/api/derive/sweep"],
  ["GET", "/api/vision/config"],
  ["PUT", "/api/vision/config"],
  ["GET", "/api/vision/status"],
  ["POST", "/api/vision/scan"],
  ["POST", "/api/vision/models"],
  ["GET", "/api/vision/people"],
  ["PUT", "/api/vision/people"],
  ["GET", "/api/vision/faces/rec1"],
  ["GET", "/api/vision/face-crop/rec1"],
  ["GET", "/api/local-data/data/records"],
];

describe("every declared route reaches a handler", () => {
  it.each(ROUTES)("%s %s", async (method, path) => {
    const res = await send(method, path, method === "GET" || method === "DELETE" ? undefined : {});
    const body = await res.text();
    expect(body, `${method} ${path} fell through to the router's 404`).not.toContain(
      "Photos has no route for",
    );
  });

  it("covers every route the app mounts", async () => {
    // The list above is hand-written, so it has to be shown to be complete: a
    // route added to `server-app.ts` and not to `ROUTES` would be untested and
    // this test would still pass. `/api/session/*` is covered by the bare
    // spelling above plus `__tests__/session-routes.test.ts`.
    const mounted = app.routes
      // `/*` is the origin gate, mounted with `app.use` rather than being a
      // route of its own.
      .filter((r) => r.path !== "/*")
      .map((r) => r.path)
      .filter((p, i, a) => a.indexOf(p) === i);
    const listed = new Set(
      ROUTES.map(([, path]) =>
        path
          .replace(/\/rec1$/, "/:id")
          .replace(/^\/api\/local-data\/.*/, "/api/local-data/*"),
      ),
    );
    listed.add("/api/session/*");
    expect(mounted.filter((p) => !listed.has(p))).toEqual([]);
  });
});

describe("a static segment wins over the record-id parameter", () => {
  // Only the segments that declare a GET. `renditions` and `crop` are POST-only
  // and a GET on either is genuinely a record lookup — asserted below, because
  // that is a decision rather than an accident.
  it.each(["cover", "style-graphic", "library"])(
    "/api/photos/%s is not read as a record id",
    async (segment) => {
      // If `:id` matched first, these would all ask the data plane for a record
      // called "cover" instead of doing their own work.
      await send("GET", `/api/photos/${segment}`);
      expect(upstreamPaths()).not.toContain(`/data/records/${segment}`);
    },
  );

  it("still reaches the POST-only routes on their own verb", async () => {
    for (const segment of ["renditions", "crop"]) {
      signedFetch.mockClear();
      await send("POST", `/api/photos/${segment}`, { requests: [], sourceImageId: "x" });
      expect(upstreamPaths(), `POST /api/photos/${segment} was read as a record id`).not.toContain(
        `/data/records/${segment}`,
      );
    }
  });

  it("still routes a real record id to the by-id handler", async () => {
    await send("GET", "/api/photos/ZBACVPJV61F3SW8FMYN2X44RP9");
    expect(upstreamPaths()).toContain("/data/records/ZBACVPJV61F3SW8FMYN2X44RP9");
  });

  it("routes the two-segment captions path to captions, not to by-id", async () => {
    await send("GET", "/api/photos/captions/rec1");
    // The captions handler queries the app-owned table; by-id would have asked
    // for the record itself.
    expect(upstreamPaths().some((p) => p.startsWith("/app-data/db/image_enriched"))).toBe(true);
    expect(upstreamPaths()).not.toContain("/data/records/captions");
  });
});

describe("the signing proxy's path handling", () => {
  it("forwards a deep data-plane path whole", async () => {
    await send("GET", "/api/local-data/data/records/rec1/metadata/image");
    expect(forwarded).toContain(`${DATA_SERVER}/data/records/rec1/metadata/image`);
  });

  it("keeps a percent-encoded segment encoded", async () => {
    // A record id can carry a colon. Decoding it here and re-joining would
    // change which record the data server is asked for.
    await send("GET", "/api/local-data/data/records/a%3Ab");
    expect(forwarded).toContain(`${DATA_SERVER}/data/records/a%3Ab`);
  });

  it("carries the query string through", async () => {
    await send("GET", "/api/local-data/data/records?limit=5&include=metadata");
    expect(forwarded).toContain(`${DATA_SERVER}/data/records?limit=5&include=metadata`);
  });

  it("mounts every verb the client issues", async () => {
    // The GET-only catch-all was the reinstall failure: every write 404'd at
    // the gateway while every unit test passed.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      forwarded = [];
      await send(method, "/api/local-data/data/records/rec1", {});
      expect(forwarded, `${method} did not reach the proxy`).toContain(
        `${DATA_SERVER}/data/records/rec1`,
      );
    }
  });
});

describe("an unrouted path under /api", () => {
  it("answers JSON rather than the shell", async () => {
    // The shell would parse as HTML at whichever caller asked and report a
    // syntax error instead of a missing route.
    const res = await send("GET", "/api/not-a-route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Photos has no route for /api/not-a-route" });
  });
});

describe("the runtime config's caching", () => {
  it("tells the browser how long it may reuse the answer", async () => {
    // Every field is a deployment fact, identical for every caller, so refetching
    // it on each navigation spends a Lambda invocation to learn nothing. The
    // ceiling matters in the other direction too: a reinstall changes
    // `apiGatewayUrl`, and an open tab serving a stale one points at a gateway
    // that no longer answers.
    const res = await send("GET", "/starkeep-runtime-config");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
  });
});
