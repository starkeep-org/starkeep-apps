/**
 * Photos' rendition table, as this app reads and writes it.
 *
 * The expensive mistakes available here are all about *paging and batching*,
 * because the whole reason renditions moved onto Photos' own plane is that a
 * library has five of them per photograph. A reader that takes one page of a
 * thousand rows sees three fifths of the library's renditions and derives the
 * rest again; a reader that walks the app's whole plane to learn about forty
 * blobs is O(everything) for an O(page) question.
 */
import { describe, expect, it } from "vitest";
import {
  loadHydratedRenditions,
  loadRenditionRows,
  loadResidency,
  putRenditionRow,
  listRenditionBlobs,
  RenditionStoreError,
  type SignedFetch,
} from "../src/photos-lib/renditions/store";
import type { RenditionRow } from "../src/photos-lib/ladder";

function row(parent: string, sizeClass: string): RenditionRow {
  return {
    parent_record_id: parent,
    size_class: sizeClass,
    sub_key: `renditions/${parent}/${sizeClass}/${parent}${sizeClass}.avif`,
    content_hash: `${parent}${sizeClass}`,
    width: 1280,
    height: 960,
    size_bytes: 1000,
    content_type: "image/avif",
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("reading the table", () => {
  it("drains every page rather than stopping at the first", async () => {
    const pages = [
      { rows: [row("a", "image-thumb")], page_token: "cut-1" },
      { rows: [row("a", "image-medium")], page_token: null },
    ];
    const asked: string[] = [];
    const fetch: SignedFetch = async (path) => {
      asked.push(path);
      return json(pages.shift());
    };

    const byParent = await loadRenditionRows(fetch, ["a"]);

    expect(byParent.get("a")!.map((r) => r.size_class)).toEqual([
      "image-thumb",
      "image-medium",
    ]);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("page_token=cut-1");
  });

  // Cut on the primary key, which is the only ordering that makes a page a
  // genuine prefix of the set being walked.
  it("orders by the primary key so the cursor cannot skip a row", async () => {
    let asked = "";
    await loadRenditionRows(
      async (path) => {
        asked = path;
        return json({ rows: [], page_token: null });
      },
      ["a"],
    );
    expect(decodeURIComponent(asked)).toContain("order=parent_record_id.asc,size_class.asc");
    expect(decodeURIComponent(asked)).toContain('{"parent_record_id":{"in":["a"]}}');
  });

  it("asks once for a page of parents, not once per parent", async () => {
    let calls = 0;
    await loadRenditionRows(
      async () => {
        calls += 1;
        return json({ rows: [], page_token: null });
      },
      ["a", "b", "c", "a"],
    );
    expect(calls).toBe(1);
  });

  it("reports a refusal rather than answering an empty library", async () => {
    await expect(
      loadRenditionRows(async () => json({ error: "nope" }, 500), ["a"]),
    ).rejects.toBeInstanceOf(RenditionStoreError);
  });
});

describe("what this node is holding", () => {
  it("asks about the keys it has, not about the whole plane", async () => {
    let body: unknown;
    const residency = await loadResidency(
      async (path, init) => {
        expect(path).toBe("/app-data/residency/lookup");
        body = JSON.parse(String(init?.body));
        return json({
          entries: [{ subKey: "renditions/a/image-thumb/x.avif", resident: true }],
        });
      },
      ["renditions/a/image-thumb/x.avif", "renditions/a/image-medium/y.avif"],
    );

    expect(body).toEqual({
      subKeys: ["renditions/a/image-thumb/x.avif", "renditions/a/image-medium/y.avif"],
    });
    // A key the answer omits is a key this node has nothing recorded for, which
    // reads as "the bytes are not here" — never as "assume they are".
    expect(residency.get("renditions/a/image-thumb/x.avif")).toBe(true);
    expect(residency.get("renditions/a/image-medium/y.avif")).toBeUndefined();
  });
});

describe("hydrating a page", () => {
  it("joins rows, residency and urls into one answer per parent", async () => {
    const fetch: SignedFetch = async (path, init) => {
      if (path.startsWith("/app-data/db/renditions")) {
        return json({ rows: [row("a", "image-thumb"), row("b", "image-medium")], page_token: null });
      }
      if (path === "/app-data/residency/lookup") {
        const asked = JSON.parse(String(init?.body)) as { subKeys: string[] };
        return json({
          entries: asked.subKeys.map((subKey) => ({
            subKey,
            resident: subKey.includes("/a/"),
          })),
        });
      }
      if (path === "/app-data/file-urls") {
        const asked = JSON.parse(String(init?.body)) as { subKeys: string[] };
        return json({
          urls: Object.fromEntries(asked.subKeys.map((k, i) => [k, `https://f.invalid/${i}`])),
        });
      }
      throw new Error(`unexpected ${path}`);
    };

    const hydrated = await loadHydratedRenditions(fetch, ["a", "b"]);

    expect(hydrated.get("a")![0]).toMatchObject({
      size_class: "image-thumb",
      availableHere: true,
    });
    expect(hydrated.get("a")![0]!.url).toBeTruthy();
    // The row is here and the bytes are not, which is what a sync round leaves
    // behind on the app-private plane: rows apply, blobs do not.
    expect(hydrated.get("b")![0]!.availableHere).toBe(false);
  });

  it("asks for nothing else when the table has no rows for the page", async () => {
    let calls = 0;
    const hydrated = await loadHydratedRenditions(async () => {
      calls += 1;
      return json({ rows: [], page_token: null });
    }, ["a"]);
    expect(hydrated.size).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("writing a rung", () => {
  it("upserts the row rather than adding a second one", async () => {
    let body: unknown;
    await putRenditionRow(async (path, init) => {
      expect(path).toBe("/app-data/db/renditions");
      expect(init?.method).toBe("POST");
      body = JSON.parse(String(init?.body));
      return json({ ok: true });
    }, row("a", "image-thumb"));
    expect(body).toEqual({ row: row("a", "image-thumb") });
  });
});

describe("listing the rendition blobs", () => {
  it("walks every page and keeps only what sits under the rendition prefix", async () => {
    const pages = [
      {
        entries: [
          { subKey: "cover", sizeBytes: 5, resident: true },
          { subKey: "renditions/a/image-thumb/x.avif", sizeBytes: 10, resident: true },
        ],
        nextCursor: "next",
      },
      {
        entries: [{ subKey: "renditions/b/image-medium/y.avif", sizeBytes: 20, resident: false }],
        nextCursor: null,
      },
    ];
    const blobs = await listRenditionBlobs(async () => json(pages.shift()));
    // `cover` is Photos' own file too, and nothing in this pass may touch it.
    expect(blobs.map((b) => b.subKey)).toEqual([
      "renditions/a/image-thumb/x.avif",
      "renditions/b/image-medium/y.avif",
    ]);
  });
});
