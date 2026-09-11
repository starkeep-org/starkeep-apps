/**
 * The per-candidate library lookup, against a fake data server.
 *
 * What this file is really asserting is the *shape of the cost*. The lookup
 * replaced a whole-library index read per run, and a lookup that quietly paged
 * the library anyway would pass every behavioural test while giving back
 * nothing. So the cases below count requests and read predicates as much as
 * they check answers.
 */
import { describe, it, expect } from "vitest";
import { createLibraryLookup } from "../src/photos-lib/import/library-lookup";
import type { SignedFetch } from "../src/photos-lib/image-processing/publish-renditions";

const SHOT = {
  capturedAt: "2026-08-30T19:17:55.000Z",
  cameraMake: "Google",
  cameraModel: "Pixel 9",
  width: 4080,
  height: 3072,
};

interface Call {
  readonly path: string;
  readonly where: Record<string, unknown> | null;
  readonly select: string | null;
  readonly pageToken: string | null;
}

/** A data server that records what it was asked and answers from a script. */
function fakeServer(pages: Record<string, unknown>[][] = [[]]): {
  fetch: SignedFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let served = 0;
  const fetch: SignedFetch = async (path) => {
    const url = new URL(path, "http://data.local");
    const where = url.searchParams.get("where");
    calls.push({
      path: url.pathname,
      where: where ? (JSON.parse(where) as Record<string, unknown>) : null,
      select: url.searchParams.get("select"),
      pageToken: url.searchParams.get("page_token"),
    });
    // The same-capture query is answered from the first page and the perceptual
    // walk from the rest, which is enough to tell a single query from a walk.
    const rows = pages[Math.min(served, pages.length - 1)] ?? [];
    const pageToken = served < pages.length - 1 ? `token-${served}` : null;
    served += 1;
    return new Response(JSON.stringify({ rows, truncated: false, page_token: pageToken }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

describe("tier 2 — one indexed query per candidate", () => {
  it("asks the image metadata table for the capture fingerprint", async () => {
    const { fetch, calls } = fakeServer([[{ record_id: "rec-1", ...rowFor(SHOT) }]]);
    const entries = await createLibraryLookup(fetch)(SHOT);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/data/metadata/image");
    expect(calls[0]!.where).toEqual({
      captured_at: SHOT.capturedAt,
      camera_make: "Google",
      camera_model: "Pixel 9",
      width: 4080,
      height: 3072,
    });
    // Six columns of seventeen. The rows are held for the length of a run.
    expect(calls[0]!.select).toBe(
      "record_id,captured_at,camera_make,camera_model,width,height,perceptual_hash",
    );
    expect(entries).toEqual([{ recordId: "rec-1", ...SHOT, perceptualHash: null }]);
  });

  // A screenshot has no camera and a re-encode has no EXIF at all. Asking about
  // a fingerprint that does not exist would match every such file against every
  // other, which is the failure `captureFingerprint` returns null to prevent —
  // and the query would be a table scan on top of being wrong.
  it("asks nothing at all when the candidate has no capture fingerprint", async () => {
    const { fetch, calls } = fakeServer();
    expect(await createLibraryLookup(fetch)({ width: 1170, height: 2532 })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("tier 3 — the perceptual index", () => {
  // No filter grammar expresses a Hamming distance, so this set cannot be
  // narrowed per candidate. What it can be is small, lazy and fetched once.
  it("is not fetched for a candidate carrying no perceptual hash", async () => {
    const { fetch, calls } = fakeServer();
    await createLibraryLookup(fetch)(SHOT);
    expect(calls.map((c) => c.select)).not.toContain("record_id,perceptual_hash");
  });

  it("selects the originals by their perceptual hash, two columns wide", async () => {
    const { fetch, calls } = fakeServer([[], [{ record_id: "orig-1", perceptual_hash: "ff".repeat(8) }]]);
    const entries = await createLibraryLookup(fetch)({ perceptualHash: "ff".repeat(8) });

    const index = calls.find((c) => c.select === "record_id,perceptual_hash");
    expect(index, "the perceptual index was never fetched").toBeTruthy();
    expect(index!.where).toEqual({ perceptual_hash: { ne: null } });
    expect(entries.map((e) => e.recordId)).toEqual(["orig-1"]);
  });

  // The whole point of the change: the index is paid once per run rather than
  // once per file. A second candidate must add no request.
  it("is fetched once per run, however many candidates ask for it", async () => {
    const { fetch, calls } = fakeServer([[{ record_id: "orig-1", perceptual_hash: "ff".repeat(8) }]]);
    const lookup = createLibraryLookup(fetch);
    await lookup({ perceptualHash: "ff".repeat(8) });
    await lookup({ perceptualHash: "ee".repeat(8) });
    await lookup({ perceptualHash: "dd".repeat(8) });
    expect(calls).toHaveLength(1);
  });

  it("walks every page of the index rather than stopping at the first", async () => {
    const { fetch, calls } = fakeServer([
      [{ record_id: "a", perceptual_hash: "11".repeat(8) }],
      [{ record_id: "b", perceptual_hash: "22".repeat(8) }],
      [{ record_id: "c", perceptual_hash: "33".repeat(8) }],
    ]);
    const entries = await createLibraryLookup(fetch)({ perceptualHash: "ff".repeat(8) });
    expect(entries.map((e) => e.recordId)).toEqual(["a", "b", "c"]);
    expect(calls.map((c) => c.pageToken)).toEqual([null, "token-0", "token-1"]);
  });

  // The findings this feeds are computed *after* the file is imported, so a
  // server that cannot answer should cost the report and not the import.
  it("degrades to no findings when the route fails, rather than throwing", async () => {
    const failing: SignedFetch = async () => new Response("nope", { status: 503 });
    await expect(createLibraryLookup(failing)({ perceptualHash: "ff".repeat(8) })).resolves.toEqual(
      [],
    );
  });
});

function rowFor(shot: typeof SHOT): Record<string, unknown> {
  return {
    captured_at: shot.capturedAt,
    camera_make: shot.cameraMake,
    camera_model: shot.cameraModel,
    width: shot.width,
    height: shot.height,
    perceptual_hash: null,
  };
}
