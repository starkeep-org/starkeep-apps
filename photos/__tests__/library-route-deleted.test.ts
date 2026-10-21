/**
 * The library route's deletion feed: `deleted=only` reaches the data server,
 * and the live delta stays as it was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/routes/photos/library";
import { authorizePhotosRoute } from "../src/lib/photos-route-server";

vi.mock("../src/lib/photos-route-server", () => ({
  authorizePhotosRoute: vi.fn(),
  withRefreshedSession: (response: Response) => response,
}));

const upstreamFetch = vi.fn();

beforeEach(() => {
  upstreamFetch.mockReset();
  upstreamFetch.mockResolvedValue(new Response(JSON.stringify({ records: [], hasMore: false })));
  (authorizePhotosRoute as ReturnType<typeof vi.fn>).mockResolvedValue({ fetch: upstreamFetch });
});

async function upstreamParams(query: string): Promise<URLSearchParams> {
  await GET(new Request(`http://localhost/api/photos/library?${query}`));
  const path = upstreamFetch.mock.calls[0]![0] as string;
  return new URLSearchParams(path.slice(path.indexOf("?") + 1));
}

describe("GET /api/photos/library", () => {
  it("asks for tombstones since the watermark, in sync order, with nothing hydrated", async () => {
    const params = await upstreamParams("updated_after=2026-10-21T00:00:00.000Z&deleted=only");
    expect(params.get("deleted")).toBe("only");
    expect(params.get("updated_after")).toBe("2026-10-21T00:00:00.000Z");
    expect(params.get("order")).toBe("updated_at.asc");
    expect(params.has("include")).toBe(false);
  });

  it("keeps the live delta free of tombstones", async () => {
    const params = await upstreamParams("updated_after=2026-10-21T00:00:00.000Z");
    expect(params.has("deleted")).toBe(false);
    expect(params.get("include")).toBe("metadata,labels");
  });

  it("reads the live library for any other value", async () => {
    const params = await upstreamParams("updated_after=2026-10-21T00:00:00.000Z&deleted=all");
    expect(params.has("deleted")).toBe(false);
  });
});
