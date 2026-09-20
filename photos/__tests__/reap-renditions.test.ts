/**
 * Collecting rendition bytes nothing references.
 *
 * Two things produce them and one pass answers both: the loser of a concurrent
 * publication, whose bytes are up under its own content hash with no row
 * pointing at them, and the rungs of an original somebody deleted.
 *
 * The failure to guard against is the opposite one. This is the only pass in
 * Photos whose purpose is deleting bytes, so every case below is really asking
 * the same question: can it be made to delete something a row still names.
 */
import { describe, expect, it } from "vitest";
import { reapRenditions } from "../src/derivation/reap-renditions";
import type { SignedFetch } from "../src/photos-lib/renditions/store";
import type { RenditionRow } from "../src/photos-lib/ladder";

function row(parent: string, sizeClass: string, hash = "keep"): RenditionRow {
  return {
    parent_record_id: parent,
    size_class: sizeClass,
    sub_key: `renditions/${parent}/${sizeClass}/${hash}.avif`,
    content_hash: hash,
    width: 400,
    height: 300,
    size_bytes: 100,
    content_type: "image/avif",
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

interface PlaneOptions {
  blobs: string[];
  rows: RenditionRow[];
  liveParents: string[];
  /** Calls that fail, to prove a failure keeps the bytes. */
  refuse?: (method: string, path: string) => boolean;
}

function plane(options: PlaneOptions) {
  const deletedBlobs: string[] = [];
  const deletedRows: unknown[] = [];
  const fetch: SignedFetch = async (path, init) => {
      if (path.startsWith("/app-data/local-files")) return Response.json({ files: [], nextCursor: null });
    if (options.refuse?.(init?.method ?? "GET", path)) return json({ error: "nope" }, 500);
    if (path.startsWith("/app-data/residency")) {
      return json({
        entries: options.blobs.map((subKey) => ({ subKey, sizeBytes: 100, resident: true })),
        nextCursor: null,
      });
    }
    if (path.startsWith("/app-data/db/renditions")) {
      if (init?.method === "DELETE") {
        deletedRows.push(JSON.parse(String(init.body)));
        return json({ changes: 1 });
      }
      return json({ rows: options.rows, page_token: null });
    }
    if (path.startsWith("/data/records")) {
      return json({ records: options.liveParents.map((id) => ({ id })) });
    }
    if (path.startsWith("/app-data/files/") && init?.method === "DELETE") {
      deletedBlobs.push(path.slice("/app-data/files/".length));
      return json({ ok: true });
    }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  };
  return { fetch, deletedBlobs, deletedRows };
}

describe("the reaping pass", () => {
  it("leaves every blob a live row names", async () => {
    const kept = row("a", "image-thumb");
    const { fetch, deletedBlobs, deletedRows } = plane({
      blobs: [kept.sub_key],
      rows: [kept],
      liveParents: ["a"],
    });

    const result = await reapRenditions(fetch);

    expect(deletedBlobs).toEqual([]);
    expect(deletedRows).toEqual([]);
    expect(result).toMatchObject({ examined: 1, orphanedBlobs: 0, orphanedRows: 0, failed: 0 });
  });

  // Two nodes derived one rung at once. Both uploaded, both registered, and
  // last-writer-wins over the HLC kept one row. The loser's bytes are what this
  // pass exists for.
  it("collects the loser of a concurrent publication", async () => {
    const winner = row("a", "image-thumb", "winner");
    const loser = `renditions/a/image-thumb/loser.avif`;
    const { fetch, deletedBlobs } = plane({
      blobs: [winner.sub_key, loser],
      rows: [winner],
      liveParents: ["a"],
    });

    const result = await reapRenditions(fetch);

    expect(deletedBlobs).toEqual([loser]);
    expect(result.orphanedBlobs).toBe(1);
  });

  // No cross-plane deletion hook exists, and inventing one would put an app's
  // private table in the path of a platform delete. So the rungs of a deleted
  // original are found the same way everything else here is.
  it("collects the rungs of an original that is gone, rows and bytes together", async () => {
    const orphan = row("gone", "image-medium");
    const kept = row("a", "image-thumb");
    const { fetch, deletedBlobs, deletedRows } = plane({
      blobs: [orphan.sub_key, kept.sub_key],
      rows: [orphan, kept],
      liveParents: ["a"],
    });

    const result = await reapRenditions(fetch);

    expect(deletedRows).toEqual([
      { where: { parent_record_id: "gone", size_class: "image-medium" } },
    ]);
    expect(deletedBlobs).toEqual([orphan.sub_key]);
    expect(result).toMatchObject({ orphanedRows: 1, orphanedBlobs: 1 });
  });

  // A failed liveness check is not evidence of death, and this pass deletes
  // things. The only safe reading of a 500 is that every parent in the batch
  // is still there.
  it("deletes nothing when it cannot find out whether the originals are alive", async () => {
    const kept = row("a", "image-thumb");
    const { fetch, deletedBlobs, deletedRows } = plane({
      blobs: [kept.sub_key],
      rows: [kept],
      liveParents: [],
      refuse: (_method, path) => path.startsWith("/data/records"),
    });

    await reapRenditions(fetch);

    expect(deletedRows).toEqual([]);
    expect(deletedBlobs).toEqual([]);
  });

  // A row that is still there has to keep pointing at something.
  it("keeps the bytes when the row that named them could not be deleted", async () => {
    const orphan = row("gone", "image-medium");
    const { fetch, deletedBlobs } = plane({
      blobs: [orphan.sub_key],
      rows: [orphan],
      liveParents: [],
      refuse: (method) => method === "DELETE",
    });

    const result = await reapRenditions(fetch);

    expect(deletedBlobs).toEqual([]);
    expect(result.failed).toBe(1);
  });

  it("asks nothing further when the plane holds no rendition bytes", async () => {
    const { fetch } = plane({ blobs: [], rows: [], liveParents: [] });
    expect(await reapRenditions(fetch)).toEqual({
      examined: 0,
      orphanedBlobs: 0,
      orphanedRows: 0,
      failed: 0,
    });
  });
});
