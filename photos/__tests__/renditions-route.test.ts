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
  it("recanonicalizes a stale request and resolves one upstream ID batch", async () => {
    upstreamFetch.mockResolvedValue(new Response(JSON.stringify({
      records: [{
        id: "rec-1",
        type: "image/jpeg",
        mime_type: "image/jpeg",
        metadata: { width: 4000, height: 3000 },
        size_bytes: 8 * 1024 * 1024,
        // The platform's size summary, which the route folds into candidates.
        stand_ins: {
          category: "image",
          fidelity: 4000,
          status: "self-canonical",
          top: 4000,
          sizes: [{
            fidelity: 1280,
            role: "smaller",
            record_id: "rend-1280",
            type: "image/avif",
            size_bytes: 120_000,
            placement: "cloud",
            url: "https://example.test/rendition",
          }],
        },
      }],
    }), { status: 200 }));

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
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const path = upstreamFetch.mock.calls[0]![0] as string;
    const params = new URLSearchParams(path.split("?")[1]);
    expect(JSON.parse(params.get("where")!)).toEqual({ id: { in: ["rec-1"] } });
    expect(params.get("include")).toBe("metadata,stand-in-urls");
    expect(params.get("variant")).toBe("photos/derived");
    const body = await response.json();
    const result = body.results[0];
    expect(result.policyVersion).toBe(currentRenditionPolicies().still.version);
    expect(result.canonicalTargetLongEdge).toBe(canonicalTarget(currentRenditionPolicies().still, 700));
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
