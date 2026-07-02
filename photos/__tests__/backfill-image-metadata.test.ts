/**
 * Tests for backfillImageMetadata — the lazy metadata backfill the photos app
 * runs when it opens a record that has no shared image-metadata row (e.g. one
 * added by the LDS folder watcher, which by design doesn't extract metadata).
 * It fetches the stored bytes, runs the same extraction as upload, and writes
 * the row.
 *
 * The data source is mocked and `fetch` is stubbed with a small router, so the
 * test exercises the wiring (file-url → bytes → extract → metadata POST) rather
 * than any real server. Node has no `createImageBitmap`, so dimensions aren't
 * decoded here; the TIFF fixture's IFD0 EXIF is what makes extraction non-empty
 * (dimension extraction itself is covered by the app at runtime / e2e).
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { resolveDataSource } from "../src/lib/data-client";
import { backfillImageMetadata } from "../src/lib/data-server-client";
import { tiffWithExif } from "./tiff-fixture";

vi.mock("../src/lib/data-client", () => ({
  resolveDataSource: vi.fn(),
}));

const SOURCE = { baseUrl: "http://ds", headers: {} as Record<string, string> };

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function bytesResponse(bytes: Uint8Array, ok = true): Response {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    ok,
    status: ok ? 200 : 404,
    arrayBuffer: async () => copy,
    text: async () => "",
  } as unknown as Response;
}

/**
 * Route fetches by URL: the file-url lookup, the blob fetch, and the metadata
 * POST. Records the POST body so tests can assert what was persisted.
 */
function installFetchRouter(opts: {
  recordId: string;
  blobUrl: string;
  blobBytes?: Uint8Array;
  blobOk?: boolean;
}): { posted: Array<{ url: string; body: unknown }> } {
  const posted: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${SOURCE.baseUrl}/data/records/${opts.recordId}/file-url`) {
      return jsonResponse({ url: opts.blobUrl });
    }
    if (url === opts.blobUrl) {
      if (opts.blobOk === false) return bytesResponse(new Uint8Array(), false);
      return bytesResponse(opts.blobBytes ?? new Uint8Array());
    }
    if (url === `${SOURCE.baseUrl}/data/records/${opts.recordId}/metadata`) {
      posted.push({ url, body: JSON.parse(init!.body as string) });
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posted };
}

describe("backfillImageMetadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (resolveDataSource as Mock).mockResolvedValue(SOURCE);
  });

  it("extracts from the stored bytes and writes the metadata row", async () => {
    const { posted } = installFetchRouter({
      recordId: "REC1",
      blobUrl: "http://blob/REC1",
      blobBytes: tiffWithExif({ make: "Acme", model: "Snapper X" }),
    });

    const wrote = await backfillImageMetadata("REC1", "image/tiff");

    expect(wrote).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({
      typeId: "image",
      metadata: { camera_make: "Acme", camera_model: "Snapper X" },
    });
  });

  it("returns false and writes nothing when the bytes yield no metadata", async () => {
    const { posted } = installFetchRouter({
      recordId: "REC2",
      blobUrl: "http://blob/REC2",
      blobBytes: Buffer.from("definitely not an image"),
    });

    const wrote = await backfillImageMetadata("REC2", "image/jpeg");

    expect(wrote).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("returns false and writes nothing when the bytes can't be fetched", async () => {
    const { posted } = installFetchRouter({
      recordId: "REC3",
      blobUrl: "http://blob/REC3",
      blobOk: false,
    });

    const wrote = await backfillImageMetadata("REC3", "image/jpeg");

    expect(wrote).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("falls back to image/jpeg when the record carries no MIME type", async () => {
    // The watcher-added records that motivate this path can have an empty
    // mime_type; backfill must still attempt extraction rather than passing "".
    installFetchRouter({
      recordId: "REC4",
      blobUrl: "http://blob/REC4",
      blobBytes: tiffWithExif({ make: "Acme", model: "Z" }),
    });

    // Passing "" must not throw; extraction proceeds on the bytes regardless.
    await expect(backfillImageMetadata("REC4", "")).resolves.toBe(true);
  });
});
