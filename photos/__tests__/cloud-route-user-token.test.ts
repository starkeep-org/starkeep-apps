import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The broker refuses every data call without the end user's token, and a route
// that signs with the app credential alone loses its write without a word: a
// cloud caption save answered 200 and left no row. Each route here must reach
// the broker through `authorizePhotosRoute`, which checks the session and adds
// the token, so the test runs the real helper and stubs only the platform.

const USER_TOKEN_HEADER = "X-Starkeep-User-Token";
const USER_TOKEN = "minted-id-token";

const signedFetch = vi.fn();
const loadAppCredentials = vi.fn();
const requireSession = vi.fn();
const mintIdToken = vi.fn();

vi.mock("@starkeep/app-client", () => ({
  USER_TOKEN_HEADER,
  loadAppCredentials: (...args: unknown[]) => loadAppCredentials(...args),
  signedFetch: (...args: unknown[]) => signedFetch(...args),
}));
vi.mock("@starkeep/app-client/auth", () => ({
  requireSession: (...args: unknown[]) => requireSession(...args),
  mintIdToken: (...args: unknown[]) => mintIdToken(...args),
}));

const captions = await import("../src/routes/photos/captions");
const cover = await import("../src/routes/photos/cover");
const styleGraphic = await import("../src/routes/photos/style-graphic");
const crop = await import("../src/routes/photos/crop");
const byId = await import("../src/routes/photos/by-id");

const RECORD = {
  id: "rec-1",
  type: "image/jpeg",
  parent_id: null,
  original_filename: "IMG_0001.jpg",
  mime_type: "image/jpeg",
  object_storage_key: "shared/image/abc",
  created_at: "2026-10-28T00:00:00.000Z",
  updated_at: "2026-10-28T00:00:00.000Z",
};

/** One broker answer that satisfies every route's reads. */
function brokerAnswer(path: string): Response {
  if (path === "/data/records/missing") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    rows: [],
    record: RECORD,
    metadata: null,
    url: "https://storage.example/upload",
  });
}

function req(method: string, init: RequestInit = {}): Request {
  return new Request("https://cloud.example/apps/photos/api/photos/x", { method, ...init });
}

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const png = { headers: { "Content-Type": "image/png" }, body: new Uint8Array([1, 2, 3]) };

const CASES: Array<[string, () => Promise<Response>]> = [
  ["GET captions", () => captions.GET(req("GET"), "rec-1")],
  ["PUT captions", () => captions.PUT(req("PUT", json({ caption: "Apple spiral" })), "rec-1")],
  ["DELETE captions", () => captions.DELETE(req("DELETE"), "rec-1")],
  ["GET cover", () => cover.GET(req("GET"))],
  ["PUT cover", () => cover.PUT(req("PUT", png))],
  ["DELETE cover", () => cover.DELETE(req("DELETE"))],
  ["GET style-graphic", () => styleGraphic.GET(req("GET"))],
  ["PUT style-graphic", () => styleGraphic.PUT(req("PUT", png))],
  ["DELETE style-graphic", () => styleGraphic.DELETE(req("DELETE"))],
  // A missing source stops the crop after its first broker call, before sharp.
  [
    "POST crop",
    () =>
      crop.POST(
        req("POST", json({ sourceImageId: "missing", cropRect: { x: 0, y: 0, width: 1, height: 1 } })),
      ),
  ],
  ["GET photo", () => byId.GET(req("GET"), "rec-1")],
  ["PATCH photo", () => byId.PATCH(req("PATCH", json({ title: "Spiral" })), "rec-1")],
  ["DELETE photo", () => byId.DELETE(req("DELETE"), "rec-1")],
];

describe("cloud Photos routes send the user's token to the broker", () => {
  beforeEach(() => {
    process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
    signedFetch.mockReset().mockImplementation(async (_creds: unknown, path: string) => brokerAnswer(path));
    loadAppCredentials.mockReset().mockResolvedValue({ appId: "photos", secret: "s" });
    requireSession.mockReset().mockResolvedValue({ sub: "user-1" });
    mintIdToken.mockReset().mockResolvedValue({ token: USER_TOKEN });
    // The presigned upload goes straight to storage and carries no token.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });

  afterEach(() => {
    delete process.env.STARKEEP_APP_CLIENT_MODE;
    vi.unstubAllGlobals();
  });

  it.each(CASES)("%s signs every broker call with the user token", async (_name, call) => {
    await call();
    expect(signedFetch).toHaveBeenCalled();
    for (const [, path, init] of signedFetch.mock.calls as Array<
      [unknown, string, { headers?: Record<string, string> } | undefined]
    >) {
      expect(init?.headers?.[USER_TOKEN_HEADER], path).toBe(USER_TOKEN);
    }
  });

  it.each(CASES)("%s refuses a caller with no session before loading the credential", async (_name, call) => {
    requireSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(loadAppCredentials).not.toHaveBeenCalled();
    expect(signedFetch).not.toHaveBeenCalled();
  });
});
