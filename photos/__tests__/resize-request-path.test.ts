/**
 * Which repair the local request path chooses, and what it refuses to move.
 *
 * Section 6.3 of the rendition-ownership project document gives a node one
 * choice per wanted rung: derive it when the original's bytes are here, fetch
 * it when another node published it, never both, and never download a 7 MB
 * photograph in order to produce a 14 KB thumbnail. `/api/resize` is where a
 * viewer's request lands, so it is where that choice is made for one rung
 * somebody is waiting on.
 *
 * The fetch branch is what these cases cover. It answers before the route
 * imports sharp, which is also what makes it testable here at all — the derive
 * branch pulls in a native decoder and belongs to the worker's own integration
 * test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertRecordsQuery } from "./helpers/records-query";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@starkeep/app-client", () => ({
  loadAppCredentials: async () => ({ appId: "photos", hmacSecret: "s", dataServerUrl: "http://lds.test" }),
  signedFetch: (_creds: unknown, path: string, init?: RequestInit) => mocks.call(path, init),
}));

import { POST } from "../src/routes/resize";

/** A 4000 px original, so every rung of the still ladder applies to it. */
const RECORD = {
  id: "p",
  type: "image",
  mime_type: "image/jpeg",
  object_storage_key: "shared/image/p",
  parent_id: null,
  original_filename: "p.jpg",
  metadata: { width: 4000, height: 3000 },
};

const rung = (sizeClass: string, edge: number) => ({
  parent_record_id: "p",
  size_class: sizeClass,
  sub_key: `renditions/p/${sizeClass}/hash-${edge}.avif`,
  content_hash: `hash-${edge}`,
  width: edge,
  height: Math.round(edge * 0.75),
  size_bytes: 14000,
  content_type: "image/avif",
});

/** Every rung this record has published, as Photos' own table answers. */
const published = [rung("image-thumb", 640), rung("image-medium", 1280), rung("image-large", 3840)];

/** What the node holds, and what it asked for. Reset per case. */
let availability: string;
let fetched: string[];
let requests: string[];

function request(body: Record<string, unknown>) {
  return POST(new Request("http://photos.test/api/resize", { method: "POST", body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  availability = "absent";
  fetched = [];
  requests = [];
  mocks.call.mockImplementation(async (path: string) => {
    requests.push(path);
    assertRecordsQuery(path);
    if (path === "/data/records/p") return Response.json({ record: RECORD });
    if (path.startsWith("/data/records?")) {
      return Response.json({ records: [{ id: "p", availability: { state: availability }, created_at: "2020-01-01", metadata: RECORD.metadata }] });
    }
    if (path.startsWith("/app-data/db/renditions")) return Response.json({ rows: published });
    if (path.startsWith("/app-data/residency")) {
      return Response.json({
        budgetBytes: 10_000_000,
        nextCursor: null,
        entries: published.map((row) => ({ subKey: row.sub_key, sizeBytes: row.size_bytes, resident: false, lastOpenedAtMs: null })),
      });
    }
    if (path.endsWith("/fetch")) {
      fetched.push(path.slice("/app-data/files/".length, -"/fetch".length));
      return Response.json({ landed: true });
    }
    throw new Error(`unexpected request: ${path}`);
  });
});

describe("the local request path with no original here", () => {
  it("fetches the one rung that answers the wanted size and downloads no original", async () => {
    // Round-up resolution over the applicable ladder: 540 px is answered by the
    // 640 rung, and 1200 by the 1280 above it. The rung the caller is waiting
    // on is the only one that moves either way.
    const response = await request({ targetId: "p", targetLongEdge: 540 });
    expect(response.status).toBe(200);
    expect(fetched).toEqual(["renditions/p/image-thumb/hash-640.avif"]);
    expect(await response.json()).toMatchObject({ published: [], declined: false });
    expect(requests.some((path) => path.includes("file-url"))).toBe(false);

    fetched = [];
    await request({ targetId: "p", targetLongEdge: 1200 });
    expect(fetched).toEqual(["renditions/p/image-medium/hash-1280.avif"]);
  });

  it("declines rather than deriving when the wanted rung was never published", async () => {
    // Answer (d) of section 6: a rung that exists nowhere and cannot be made
    // here leaves the record painted at whatever it has, with nothing
    // scheduled. A decline, not an error, and not a derivation from an original
    // this node would have to download first.
    const thumb = published.splice(0, 1);
    try {
      const response = await request({ targetId: "p", targetLongEdge: 540 });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ declined: true, fetched: [] });
      expect(fetched).toEqual([]);
    } finally {
      published.unshift(...thumb);
    }
  });

  it("never reads the original's bytes to answer a request for a rung", async () => {
    await request({ targetId: "p" });
    // Every published rung, since the caller named no size — and still nothing
    // that would move the photograph itself.
    expect(fetched.length).toBe(published.length);
    expect(requests.some((path) => path.includes("/file-url") || path.includes("/files/shared"))).toBe(false);
  });
});
