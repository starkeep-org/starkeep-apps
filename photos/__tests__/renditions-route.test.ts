import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/routes/photos/renditions";
import { canonicalTarget, currentRenditionPolicies } from "../src/photos-lib/rendition-policy";
import { authorizePhotosRoute } from "../src/lib/photos-route-server";

vi.mock("../src/lib/photos-route-server", () => ({
  authorizePhotosRoute: vi.fn(),
  withRefreshedSession: (response: Response) => response,
}));

const upstreamFetch = vi.fn();

beforeEach(() => {
  process.env.STARKEEP_APP_CLIENT_MODE = "cloud";
  upstreamFetch.mockReset();
  (authorizePhotosRoute as ReturnType<typeof vi.fn>).mockResolvedValue({ fetch: upstreamFetch });
});

function request(body: unknown) {
  return { json: async () => body } as never;
}

describe("POST /api/photos/renditions", () => {
  const MEDIUM_SUBKEY = "renditions/rec-1/image-medium/abc.webp";

  /** A shared page carrying the source's dimensions, and Photos' own rungs. */
  function planes(): (path: string, init?: { method?: string; body?: string }) => Promise<Response> {
    return async (path, init) => {
      if (path.startsWith("/app-data/local-files")) return Response.json({ files: [], nextCursor: null });
      if (path.startsWith("/data/records")) {
        return new Response(JSON.stringify({
          records: [{
            id: "rec-1",
            type: "image/jpeg",
            mime_type: "image/jpeg",
            metadata: { width: 4000, height: 3000 },
          }],
        }), { status: 200 });
      }
      if (path.startsWith("/app-data/db/renditions")) {
        return new Response(JSON.stringify({
          rows: [{
            parent_record_id: "rec-1",
            size_class: "image-medium",
            sub_key: MEDIUM_SUBKEY,
            content_hash: "abc",
            width: 1280,
            height: 960,
            size_bytes: 40_000,
            content_type: "image/webp",
          }],
          page_token: null,
        }), { status: 200 });
      }
      if (path === "/app-data/residency/lookup") {
        const body = JSON.parse(String(init?.body)) as { subKeys: string[] };
        return new Response(JSON.stringify({
          entries: body.subKeys.map((subKey) => ({
            subKey,
            sizeBytes: 40_000,
            // Not here. In cloud mode the URL still answers, because the cloud
            // holds what it has a row for.
            resident: false,
            lastOpenedAtMs: null,
          })),
        }), { status: 200 });
      }
      if (path === "/app-data/file-urls") {
        return new Response(JSON.stringify({
          urls: { [MEDIUM_SUBKEY]: "https://example.test/rendition" },
          expiresIn: 3600,
        }), { status: 200 });
      }
      throw new Error(`unexpected ${path}`);
    };
  }

  it("recanonicalizes a stale request and resolves one upstream ID batch", async () => {
    upstreamFetch.mockImplementation(planes());

    // A requirement inside the medium rung's range, paired with a target from a
    // policy that no longer exists. The server recanonicalizes the requirement
    // and ignores the stale target.
    const response = await POST(request({ requests: [{
      recordId: "rec-1",
      policyVersion: "stale",
      requiredLongEdge: 700,
      targetLongEdge: 400,
    }] }));
    expect(response.status).toBe(200);
    const recordCalls = upstreamFetch.mock.calls.filter(
      (call) => (call[0] as string).startsWith("/data/records"),
    );
    expect(recordCalls).toHaveLength(1);
    const params = new URLSearchParams((recordCalls[0]![0] as string).split("?")[1]);
    expect(JSON.parse(params.get("where")!)).toEqual({ id: { in: ["rec-1"] } });
    expect(params.get("include")).toBe("metadata");
    // The platform has nothing to say about a rung: the rows are Photos' own.
    expect(params.get("variant")).toBeNull();
    const body = await response.json();
    const result = body.results[0];
    expect(result.policyVersion).toBe(currentRenditionPolicies().still.version);
    expect(result.canonicalTargetLongEdge).toBe(canonicalTarget(currentRenditionPolicies().still, 700));
    expect(result.decision.ideal).toMatchObject({
      id: "abc",
      available: true,
      urlLifetime: { kind: "expires" },
    });
    // The client asks in pixels and is answered in pixels. A rung's name is an
    // implementation detail of Photos' ladder and never crosses the wire.
    expect(JSON.stringify(result)).not.toContain("image-medium");
  });

  it("rejects invalid whole-pixel requirements before an upstream call", async () => {
    const response = await POST(request({ requests: [{
      recordId: "rec-1",
      policyVersion: "v",
      requiredLongEdge: 12.5,
      targetLongEdge: 400,
    }] }));
    expect(response.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
