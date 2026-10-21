/**
 * A source the data server cannot produce is "unavailable", not "failed".
 *
 * The sweep retries only unavailable sources on a timer, so the distinction is
 * what decides whether a phone's video, synced before its upload finished, is
 * ever derived without an unrelated change waking the sweep.
 */
import { describe, expect, it } from "vitest";
import { fetchSource, SourceUnavailableError } from "@/derivation/engine/source-fetch";

const fileUrl = (url: string) => async () => Response.json({ url });

describe("fetchSource", () => {
  it("returns the file's response when both requests succeed", async () => {
    const res = await fetchSource(fileUrl("http://127.0.0.1:9820/data/files/t"), "rec", async (url) => {
      expect(url).toBe("http://127.0.0.1:9820/data/files/t");
      return new Response("bytes");
    });
    expect(await res.text()).toBe("bytes");
  });

  it("calls a 502 from file-url unavailable: the bytes are on neither this node nor the cloud", async () => {
    const attempt = fetchSource(async () => new Response("{}", { status: 502 }), "rec");
    await expect(attempt).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(attempt).rejects.toThrow("file-url failed: 502");
  });

  it("calls a failed file read unavailable too", async () => {
    const attempt = fetchSource(fileUrl("http://x/t"), "rec", async () => new Response("gone", { status: 404 }));
    await expect(attempt).rejects.toBeInstanceOf(SourceUnavailableError);
  });
});
