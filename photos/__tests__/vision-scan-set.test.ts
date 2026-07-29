import { describe, expect, it, vi } from "vitest";
import { isOriginal, listOriginals, type ListedRecord } from "@/vision/scan-set";

/**
 * The scan set and the walk that finds it.
 *
 * Both used to live inside the worker, which imports the ONNX engine and is
 * therefore not importable from a test. That is the reason they had no coverage,
 * and moving them out is the fix — not a concession to testing.
 */

const original = (id: string): ListedRecord => ({ id, parent_id: null, labels: [] });

const derived = (id: string, parent: string, key: string): ListedRecord => ({
  id,
  parent_id: parent,
  labels: [{ app_id: "photos", key, value: "" }],
});

/** A fake data server that serves fixed pages in order. */
function pagingServer(pages: Array<{ records: ListedRecord[]; nextCursor?: string | null }>) {
  const requested: string[] = [];
  let index = 0;
  const fetchRecords = async (path: string) => {
    requested.push(path);
    const page = pages[index++];
    if (!page) throw new Error(`asked for page ${index}, only ${pages.length} defined`);
    return new Response(JSON.stringify(page), { status: 200 });
  };
  return { fetchRecords, requested };
}

describe("isOriginal", () => {
  it("accepts a record with no parent and no derivation label", () => {
    expect(isOriginal(original("a"))).toBe(true);
  });

  it("rejects thumbnails and crops", () => {
    expect(isOriginal(derived("t", "a", "thumbnail"))).toBe(false);
    expect(isOriginal(derived("c", "a", "crop"))).toBe(false);
  });

  it("rejects anything with a parent, even unlabelled", () => {
    // The label may not have arrived yet — a record and its labels share a
    // request but not a transaction. Scanning it would double the work of the
    // parent it was derived from.
    expect(isOriginal({ id: "x", parent_id: "a", labels: [] })).toBe(false);
  });

  it("accepts a record with no labels field at all", () => {
    expect(isOriginal({ id: "a", parent_id: null })).toBe(true);
  });

  it("ignores another app's thumbnail key", () => {
    // Namespaces exist so a `thumbnail` key meaning something else in another
    // app is not a collision. Reading unscoped would silently shrink the scan
    // set by whatever some unrelated app happens to have labelled.
    const record: ListedRecord = {
      id: "a",
      parent_id: null,
      labels: [{ app_id: "some-other-app", key: "thumbnail", value: "" }],
    };
    expect(isOriginal(record)).toBe(true);
  });

  it("is not fooled by Photos' other keys", () => {
    const record: ListedRecord = {
      id: "a",
      parent_id: null,
      labels: [{ app_id: "photos", key: "face-count", value: "2" }],
    };
    expect(isOriginal(record)).toBe(true);
  });
});

describe("listOriginals", () => {
  it("returns only the originals from a page", async () => {
    const { fetchRecords } = pagingServer([
      {
        records: [original("a"), derived("t", "a", "thumbnail"), original("b"), derived("c", "b", "crop")],
        nextCursor: null,
      },
    ]);
    expect(await listOriginals(fetchRecords)).toEqual(["a", "b"]);
  });

  it("pages to exhaustion, and a short page is not the end", async () => {
    // The data server can return fewer rows than asked for — a label whose
    // record was deleted drops out of the join. Stopping on the first short
    // page silently skips images, and the scan under-reports forever.
    const { fetchRecords, requested } = pagingServer([
      { records: [original("a")], nextCursor: "cur-1" },
      { records: [original("b")], nextCursor: "cur-2" },
      { records: [original("c")], nextCursor: null },
    ]);
    expect(await listOriginals(fetchRecords, 200)).toEqual(["a", "b", "c"]);
    expect(requested).toHaveLength(3);
    expect(requested[1]).toContain("cursor=cur-1");
    expect(requested[2]).toContain("cursor=cur-2");
  });

  it("terminates when the server omits nextCursor entirely", async () => {
    // A current data server sends `nextCursor: null`; one older than that
    // contract omits the field, and `undefined !== null` loops forever. The
    // failure is a hang, not a wrong answer, so it survives every test that
    // uses a fake returning an explicit null.
    const { fetchRecords } = pagingServer([{ records: [original("a")] }]);
    expect(await listOriginals(fetchRecords)).toEqual(["a"]);
  });

  it("sends no cursor on the first request", async () => {
    const { fetchRecords, requested } = pagingServer([{ records: [], nextCursor: null }]);
    await listOriginals(fetchRecords);
    expect(requested[0]).not.toContain("cursor=");
    expect(requested[0]).toContain("include=labels");
  });

  it("percent-encodes a cursor that needs it", async () => {
    const { fetchRecords, requested } = pagingServer([
      { records: [], nextCursor: "a b/c+d" },
      { records: [], nextCursor: null },
    ]);
    await listOriginals(fetchRecords);
    expect(requested[1]).toContain(`cursor=${encodeURIComponent("a b/c+d")}`);
  });

  it("honours the page size it is given", async () => {
    const { fetchRecords, requested } = pagingServer([{ records: [], nextCursor: null }]);
    await listOriginals(fetchRecords, 25);
    expect(requested[0]).toContain("limit=25");
  });

  it("throws on a failed listing rather than reporting an empty library", async () => {
    // Silently returning [] would make a scan "succeed" having processed
    // nothing, and the Scan card would report a completed pass.
    const failing = vi.fn(async () => new Response("nope", { status: 403 }));
    await expect(listOriginals(failing)).rejects.toThrow(/403/);
  });
});
