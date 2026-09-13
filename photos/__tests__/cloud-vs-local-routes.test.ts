/**
 * The routes that answer differently on the two surfaces, asserted as a table.
 *
 * Gap 2 of the plan's section 3.4: `vision-remote-guard.test.ts` tests
 * `isRemoteDataTarget()` in isolation, and nothing asserted that a given route
 * actually answers 501 with `STARKEEP_APP_CLIENT_MODE=cloud` and succeeds
 * without it. The migration rerouted every one of them, so the fact that each
 * still runs its guard first is a fact about the new dispatch table rather than
 * about the old directory tree.
 *
 * Why any of these refuse is worth restating, because "not implemented" reads
 * like an omission:
 *
 *   - **`/api/vision/*`** is on-device face recognition. A cloud-served Photos
 *     has no `app-local/` directory, no models, and no business running
 *     inference on someone else's hardware. The refusal is the privacy
 *     guarantee, not a gap in it.
 *   - **`/api/derive/*`** is a whole-library sweep in a `worker_threads` pool.
 *     The cloud process is a request-scoped Lambda with a third of a core and
 *     thirty seconds, which would time out having done and discarded its work.
 *     Cloud derivation is on demand and bounded to what a viewer is looking at.
 *   - **`/api/local-sync-handoff`** reads the two HttpOnly cookies and hands
 *     them to the sync daemon. In the cloud the server holds the session and
 *     the daemon runs on the user's own machine, so there is nothing to hand
 *     anything to.
 *
 * Driven through the real Hono app, so what is asserted is what a request to
 * that path gets — not what a function returns when called directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
let root: string;

/**
 * One request, on the surface named. The origin gate is inert locally and
 * deny-by-default in cloud mode, so a cloud request carries a session cookie:
 * without it every case below would answer the gate's 401 and the test would be
 * asserting the gate rather than the route.
 */
async function on(surface: "cloud" | "local", method: string, path: string): Promise<Response> {
  if (surface === "cloud") process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
  else delete process.env.STARKEEP_APP_CLIENT_MODE;
  const headers: Record<string, string> = { "sec-fetch-dest": "empty" };
  if (surface === "cloud") headers.cookie = "sk_session=whatever";
  const init: RequestInit = { method, headers };
  if (method !== "GET") {
    init.body = JSON.stringify({ action: "start", faces: {} });
    headers["Content-Type"] = "application/json";
  }
  return app.fetch(new Request(`${ORIGIN}${path}`, init));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "photos-surfaces-"));
  process.env.STARKEEP_DIR = root;
  delete process.env.STARKEEP_APP_CLIENT_MODE;
  delete process.env.STARKEEP_FORCE_REMOTE;
  signedFetch.mockReset();
  loadAppCredentials.mockReset();
  loadAppCredentials.mockResolvedValue({
    appId: "photos",
    hmacSecret: "test-secret",
    dataServerUrl: "http://data.test",
  });
  signedFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ records: [], rows: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.STARKEEP_APP_CLIENT_MODE;
});

/** The routes whose answer depends on which surface is serving. */
const REFUSED_IN_CLOUD: ReadonlyArray<[string, string]> = [
  ["GET", "/api/vision/status"],
  ["GET", "/api/vision/config"],
  ["PUT", "/api/vision/config"],
  ["GET", "/api/vision/people"],
  ["PUT", "/api/vision/people"],
  ["POST", "/api/vision/scan"],
  ["POST", "/api/vision/models"],
  ["GET", "/api/vision/faces/rec1"],
  ["GET", "/api/vision/face-crop/rec1"],
  ["GET", "/api/derive/status"],
  ["POST", "/api/derive/sweep"],
];

describe("routes that run only where the photos and the models live", () => {
  it.each(REFUSED_IN_CLOUD)("%s %s answers 501 in cloud mode", async (method, path) => {
    const res = await on("cloud", method, path);
    expect(res.status).toBe(501);
    // 501, not 404 and not an empty result: the route exists and the shape of
    // the answer is "not here" rather than "no such thing". An empty result
    // would read as "nothing found yet" and send someone looking for a scan
    // that will never run.
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });

  it.each(REFUSED_IN_CLOUD)("%s %s runs on the local surface", async (method, path) => {
    const res = await on("local", method, path);
    expect(res.status, `${method} ${path} refused locally`).not.toBe(501);
  });

  it("refuses on a cloud build even when the runtime env is missing", async () => {
    // The second of the guard's two independent signals. `STARKEEP_FORCE_REMOTE`
    // is baked in by `infra/build-bundle.ts`, so a cloud *build* refuses even
    // if its Lambda environment is misconfigured — which is the case where one
    // signal alone would be a single point of failure.
    delete process.env.STARKEEP_APP_CLIENT_MODE;
    process.env.STARKEEP_FORCE_REMOTE = "true";
    const res = await app.fetch(new Request(`${ORIGIN}/api/vision/status`));
    expect(res.status).toBe(501);
  });

  it("touches no disk before refusing", async () => {
    // The guard runs first, which is what makes the refusal a statement about
    // the deployment rather than about whether a directory happens to exist.
    process.env.STARKEEP_DIR = "/nonexistent/photos-should-not-look-here";
    const res = await on("cloud", "GET", "/api/vision/status");
    expect(res.status).toBe(501);
  });
});

describe("the local sync handoff", () => {
  it("answers 400 in cloud mode, where there is no daemon to hand anything to", async () => {
    const res = await on("cloud", "POST", "/api/local-sync-handoff");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No local daemon on the cloud surface" });
  });

  it("gets as far as asking for a session on the local surface", async () => {
    // Locally there are no cookies in this request, so 401 is the right answer
    // — and it is the answer that proves the cloud refusal above ran instead.
    const res = await on("local", "POST", "/api/local-sync-handoff");
    expect(res.status).toBe(401);
  });
});

describe("the routes that serve both surfaces", () => {
  it.each([
    ["GET", "/api/photos/library"],
    ["POST", "/api/photos/renditions"],
  ])("%s %s is not surface-gated", async (method, path) => {
    // These branch internally — local verdicts are read from disk only on the
    // local surface — but neither refuses. A 501 here would be an empty grid in
    // the cloud.
    for (const surface of ["cloud", "local"] as const) {
      const res = await on(surface, method, path);
      expect(res.status, `${method} ${path} answered 501 on ${surface}`).not.toBe(501);
    }
  });

  it("keeps /api/resize available on both, because the cloud has its own handler", async () => {
    // The manifest routes `POST /api/resize` to the separate `api` Lambda in
    // the cloud, so this route is the local surface's. It must not refuse on
    // either: the Hono app is what answers it locally, and a refusal keyed off
    // the client mode would break a local install whose data server is remote.
    for (const surface of ["cloud", "local"] as const) {
      const res = await on(surface, "POST", "/api/resize");
      expect(res.status, `resize answered 501 on ${surface}`).not.toBe(501);
    }
  });
});
