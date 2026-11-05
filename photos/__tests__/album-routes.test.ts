/**
 * The album and public-link routes, at the HTTP boundary, with the platform's
 * signing mocked: what each one asks the data plane for.
 *
 * - Membership is the `photos/album` label with the album's id, added and
 *   retracted through the label routes.
 * - Deleting an album retracts every member the reverse index finds, then
 *   marks the row deleted; it never deletes a photo.
 * - A public link names the album by label, through the same platform routes
 *   in both modes; on the desktop the local data server forwards them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signedFetch = vi.fn();

vi.mock("@starkeep/app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@starkeep/app-client")>();
  return {
    ...actual,
    loadAppCredentials: async () => ({ appId: "photos", hmacSecret: "s", dataServerUrl: "http://data.test" }),
    signedFetch: (...args: unknown[]) => signedFetch(...args),
  };
});
vi.mock("@starkeep/app-client/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@starkeep/app-client/auth")>()),
  requireSession: async () => ({ sub: "user-1" }),
  mintIdToken: async () => ({ token: "id-token" }),
}));

import { app } from "@/server-app";
import * as publicLinks from "@/routes/public-links";
import { cloudPhotosUrl } from "@/routes/public-links";

/** A cloud request, past the gateway: the route modules, called directly. */
function cloudRequest(method: string, body?: unknown): Request {
  return new Request("https://cloud.example/apps/photos/api/public-links", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

const ID = "4de58a3c4d2a33014de58a3c4d2a3301";
const SHARE = "11111111-2222-3333-4444-555555555555";

type Call = { path: string; method: string; body: unknown };
let calls: Call[];
let answers: Array<(call: Call) => unknown>;

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://photos.test${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("STARKEEP_APP_CLIENT_MODE", "");
  calls = [];
  answers = [];
  signedFetch.mockReset();
  signedFetch.mockImplementation(async (_creds: unknown, path: string, init?: RequestInit) => {
    const call = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const answer = answers.shift();
    return new Response(JSON.stringify(answer ? answer(call) : {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("album membership", () => {
  it("adds and removes the album label with the album's id", async () => {
    const res = await send("POST", `/api/albums/${ID}/members`, { add: ["r1", "r2", "r1"], remove: ["r3"] });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        path: "/data/labels",
        method: "POST",
        body: { labels: [{ recordId: "r1", key: "album", value: ID }, { recordId: "r2", key: "album", value: ID }] },
      },
      { path: "/data/labels/retract", method: "POST", body: { labels: [{ recordId: "r3", key: "album", value: ID }] } },
    ]);
  });

  it("refuses an id that is not an album's", async () => {
    expect((await send("POST", "/api/albums/Summer/members", { add: ["r1"] })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("albums", () => {
  it("lists albums page by page, within the data server's 500-row limit", async () => {
    const row = (album_id: string, title: string) => ({ album_id, title, cover_record_id: null, created_at_ms: 1, deleted: false });
    answers.push(() => ({ rows: [row(ID, "One")], page_token: "next" }));
    answers.push(() => ({ rows: [row("5de58a3c4d2a33014de58a3c4d2a3301", "Two")], page_token: null }));
    const res = await send("GET", "/api/albums");
    expect(res.status).toBe(200);
    const { albums } = (await res.json()) as { albums: Array<{ title: string }> };
    expect(albums.map((a) => a.title).sort()).toEqual(["One", "Two"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.path).toBe("/app-data/db/albums?limit=500");
    expect(calls[1]!.path).toBe("/app-data/db/albums?limit=500&page_token=next");
  });

  it("answers 502 with the data server's message when the read is refused", async () => {
    signedFetch.mockImplementationOnce(async () => Response.json({ error: "limit must be at most 500" }, { status: 400 }));
    const res = await send("GET", "/api/albums");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("limit must be at most 500");
  });

  it("creates an album as a row with a random id and no members", async () => {
    const res = await send("POST", "/api/albums", { title: "  Summer " });
    expect(res.status).toBe(201);
    const { album } = (await res.json()) as { album: { id: string; title: string } };
    expect(album.id).toMatch(/^[0-9a-f]{32}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/app-data/db/albums",
      method: "POST",
      body: { row: { album_id: album.id, title: "Summer", deleted: false } },
    });
  });

  it("deletes an album by retracting every member it finds, then marking the row", async () => {
    answers.push(() => ({ records: [{ id: "r1" }], nextCursor: "next" }));
    answers.push(() => ({ records: [{ id: "r2" }], nextCursor: null }));
    const res = await send("DELETE", `/api/albums/${ID}`);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.path.split("?")[0])).toEqual([
      "/data/records",
      "/data/records",
      "/data/labels/retract",
      "/app-data/db/albums",
    ]);
    expect(calls[0]!.path).toContain(`labelValue=${ID}`);
    expect(calls[1]!.path).toContain("page_token=next");
    expect(calls[2]!.body).toEqual({
      labels: [{ recordId: "r1", key: "album", value: ID }, { recordId: "r2", key: "album", value: ID }],
    });
    expect(calls[3]!.body).toEqual({ row: { album_id: ID, deleted: true } });
    // No photo is ever deleted.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("public links", () => {
  it("are made by local Photos through the same platform routes, which the data server forwards", async () => {
    answers.push(() => ({
      publicShare: { id: SHARE, linkToken: "t".repeat(22), source: { kind: "label", key: "album", value: ID }, title: "Summer" },
    }));
    const res = await send("POST", "/api/public-links", { albumId: ID, title: "Summer" });
    expect(res.status).toBe(201);
    expect(calls[0]).toMatchObject({
      path: "/data/public-shares",
      method: "POST",
      body: { source: { kind: "label", key: "album", value: ID }, title: "Summer" },
    });

    answers.push(() => ({
      publicShares: [
        { id: SHARE, linkToken: "t".repeat(22), source: { kind: "label", key: "album", value: ID }, title: "Summer" },
        {
          id: "other",
          linkToken: "u".repeat(22),
          source: { kind: "label", key: "faces", value: "Alice" },
          title: "x",
        },
        { id: "one", linkToken: "v".repeat(22), source: { kind: "record", recordId: "r1" }, title: "Beach" },
      ],
      mayPublish: true,
    }));
    const listed = (await (await send("GET", "/api/public-links")).json()) as {
      available: boolean;
      links: Array<{ albumId: string | null; photoId: string | null }>;
    };
    expect(listed.available).toBe(true);
    expect(listed.links.map((l) => [l.albumId, l.photoId])).toEqual([
      [ID, null],
      [null, "r1"],
    ]);
  });

  it("are made for one photo as a record share, which serves its stand-in", async () => {
    answers.push(() => ({
      publicShare: { id: SHARE, linkToken: "t".repeat(22), source: { kind: "record", recordId: "r1" }, title: "Beach" },
    }));
    const res = await send("POST", "/api/public-links", { photoId: "r1", title: "Beach" });
    expect(res.status).toBe(201);
    // No `serves`: the platform's default is the stand-in, and Photos may ask for nothing else.
    expect(calls[0]).toMatchObject({
      path: "/data/public-shares",
      method: "POST",
      body: { source: { kind: "record", recordId: "r1" }, title: "Beach" },
    });
    expect(calls[0]!.body).not.toHaveProperty("serves");
    expect(((await res.json()) as { link: { photoId: string; albumId: null } }).link).toMatchObject({
      photoId: "r1",
      albumId: null,
    });
  });

  it("need an album or a photo", async () => {
    expect((await send("POST", "/api/public-links", { title: "Summer" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("say why there are none when this computer cannot reach the cloud", async () => {
    signedFetch.mockImplementationOnce(async () =>
      Response.json({ error: "This machine is not signed in to the cloud yet" }, { status: 503 }),
    );
    const res = await send("GET", "/api/public-links");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: false,
      reason: "This machine is not signed in to the cloud yet",
    });
  });

  it("pass a refused creation through with the platform's message", async () => {
    signedFetch.mockImplementationOnce(async () =>
      Response.json({ error: "photos was not approved to publish public links" }, { status: 403 }),
    );
    const res = await send("POST", "/api/public-links", { albumId: ID, title: "Summer" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("not approved");
  });

  it("name the album by its label in the cloud", async () => {
    vi.stubEnv("STARKEEP_APP_CLIENT_MODE", "cloud");
    answers.push(() => ({
      publicShare: {
        id: SHARE,
        linkToken: "t".repeat(22),
        source: { kind: "label", key: "album", value: ID },
        title: "Summer",
        createdAtMs: 1,
        expiresAtMs: null,
      },
    }));
    const res = await publicLinks.POST(cloudRequest("POST", { albumId: ID, title: "Summer", lifetime: "7d" }));
    expect(res.status).toBe(201);
    expect(calls[0]).toEqual({
      path: "/data/public-shares",
      method: "POST",
      body: { source: { kind: "label", key: "album", value: ID }, title: "Summer", lifetime: "7d" },
    });
    expect(((await res.json()) as { link: { albumId: string } }).link.albumId).toBe(ID);
  });

  it("change and stop a link by its id", async () => {
    vi.stubEnv("STARKEEP_APP_CLIENT_MODE", "cloud");
    answers.push(() => ({ publicShare: { id: SHARE, source: { kind: "label", key: "album", value: ID } } }));
    expect((await publicLinks.PATCH(cloudRequest("PATCH", { rotateLink: true, other: 1 }), SHARE)).status).toBe(200);
    expect(calls[0]).toEqual({ path: `/data/public-shares/${SHARE}`, method: "PATCH", body: { rotateLink: true } });
    expect((await publicLinks.DELETE(cloudRequest("DELETE"), SHARE)).status).toBe(200);
    expect(calls[1]).toMatchObject({ path: `/data/public-shares/${SHARE}`, method: "DELETE" });
    expect((await publicLinks.DELETE(cloudRequest("DELETE"), "../x")).status).toBe(404);
    expect(calls).toHaveLength(2);
  });
});

describe("cloudPhotosUrl", () => {
  it("prefers the CloudFront address, then the gateway, and reads nothing else", () => {
    const at = (config: unknown) => cloudPhotosUrl(() => JSON.stringify(config));
    expect(at({ publicBaseUrl: "https://d1.cloudfront.net/", apiGatewayUrl: "https://gw" })).toBe(
      "https://d1.cloudfront.net/apps/photos/",
    );
    expect(at({ apiGatewayUrl: "https://gw.example" })).toBe("https://gw.example/apps/photos/");
    expect(at({ publicBaseUrl: "javascript:alert(1)" })).toBeNull();
    expect(cloudPhotosUrl(() => "{")).toBeNull();
  });
});


describe("publicLinkUrl", () => {
  it("points at cloud Photos from the desktop, and at this page's origin in the cloud", async () => {
    const { publicLinkUrl } = await import("@/lib/albums-client");
    const token = "t".repeat(22);
    expect(publicLinkUrl(token, "https://d1.cloudfront.net/apps/photos/", "http://localhost:63069")).toBe(
      `https://d1.cloudfront.net/apps/photos/p/${token}`,
    );
    expect(publicLinkUrl(token, null, "https://d1.cloudfront.net")).toMatch(
      new RegExp(`^https://d1\\.cloudfront\\.net(/apps/photos)?/p/${token}$`),
    );
  });
});
