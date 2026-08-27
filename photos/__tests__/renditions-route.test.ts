import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/photos/renditions/route";
import { currentRenditionPolicies } from "../src/photos-lib/rendition-policy";
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
  it("recanonicalizes a stale request and resolves one upstream ID batch", async () => {
    upstreamFetch.mockResolvedValue(new Response(JSON.stringify({
      records: [{
        id: "rec-1",
        type: "image/jpeg",
        mime_type: "image/jpeg",
        metadata: { width: 4000, height: 3000 },
        variant_candidates: [{
          id: "rend-1280",
          type: "image/webp",
          label_value: "image-medium",
          width: 1280,
          height: 960,
          long_edge: 1280,
          available_here: false,
          url: "https://example.test/rendition",
          url_lifetime: { kind: "expires", expires_at: "2026-08-28T00:00:00.000Z" },
        }],
      }],
    }), { status: 200 }));

    const response = await POST(request({ requests: [{
      recordId: "rec-1",
      policyVersion: "stale",
      requiredLongEdge: 500,
      targetLongEdge: 400,
    }] }));
    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const path = upstreamFetch.mock.calls[0]![0] as string;
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("ids")).toBe("rec-1");
    expect(params.get("include")).toBe("metadata");
    expect(params.get("variant")).toBe("photos/rendition");
    const body = await response.json();
    const result = body.results[0];
    expect(result.policyVersion).toBe(currentRenditionPolicies().still.version);
    expect(result.canonicalTargetLongEdge).toBe(1280);
    expect(result.decision.ideal).toMatchObject({
      id: "rend-1280",
      available: true,
      urlLifetime: { kind: "expires" },
    });
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
