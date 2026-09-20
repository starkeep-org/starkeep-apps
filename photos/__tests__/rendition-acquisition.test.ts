import { describe, expect, it, vi } from "vitest";
import { fetchPublishedRenditions } from "../src/photos-lib/renditions/acquire";
import { resolveFor } from "../src/routes/photos/library";

vi.mock("@starkeep/app-client", () => ({ loadAppCredentials: vi.fn(), signedFetch: vi.fn() }));
const rung = (size_class: string, edge: number, availableHere: boolean) => ({ parent_record_id: "p", size_class,
  sub_key: `renditions/p/${size_class}/hash.avif`, content_hash: "hash", width: edge, height: edge,
  size_bytes: 14000, content_type: "image/avif", availableHere, url: `https://example.test/${size_class}` });

describe("desktop acquisition and paint", () => {
  it("fetches 14 KB of published rendition and never reads the 7 MB original", async () => {
    const row = rung("image-thumb", 640, false);
    const requests: string[] = [];
    let downloaded = 0;
    const call = async (path: string) => {
      requests.push(path);
      if (path === "/app-data/residency") return Response.json({ budgetBytes: 10000000, nextCursor: null,
        entries: [{ subKey: row.sub_key, resident: false, sizeBytes: 14000, lastOpenedAtMs: null }] });
      if (path.startsWith("/data/records?")) return Response.json({ records: [{ id: "p", size_bytes: 7000000, created_at: "2020-01-01" }] });
      if (path.endsWith("/fetch")) { downloaded += 14000; return Response.json({ landed: true }); }
      throw Error(`unexpected byte request: ${path}`);
    };
    expect(await fetchPublishedRenditions(call, [row.sub_key])).toEqual([row.sub_key]);
    expect(downloaded).toBe(14000);
    expect(requests.some(path => path.includes("file-url"))).toBe(false);
  });

  it("leaves a smaller rung final when neither original nor published ideal exists", () => {
    const result = resolveFor({ id: "p", mime_type: "image/jpeg", metadata: { width: 4000, height: 3000 },
      availability: { state: "absent" } }, [rung("image-thumb", 640, true)], [1280], false, null)["1280"]!;
    expect(result.ideal.state).toBe("missing");
    expect(result.fallback?.longEdge).toBe(640);
  });

  it("offers a larger resident rung only to the local viewer", () => {
    const record = { id: "p", mime_type: "image/jpeg", metadata: { width: 4000, height: 3000 }, availability: { state: "instant" } };
    const rows = [rung("image-thumb", 640, true), rung("image-screen", 2560, true)];
    const local = resolveFor(record, rows, [1280], false, null)["1280"]!;
    expect(local.fallback?.longEdge).toBe(640);
    expect(local.viewerFallback?.longEdge).toBe(2560);
    expect(resolveFor(record, rows, [1280], true, null)["1280"]!.viewerFallback).toBeUndefined();
  });
});
