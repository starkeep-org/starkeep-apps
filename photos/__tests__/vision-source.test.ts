import { describe, expect, it, vi } from "vitest";
import { chooseResidentSize, fetchResidentImage, scaleBox } from "@/vision/source";
import type { WireStandInSize, WireStandInSummary } from "@/photos-lib/stand-in-candidates";

/**
 * What vision reads for a photograph: a size already on this machine, never an
 * original downloaded for the purpose.
 */

function size(
  fidelity: number,
  placement: WireStandInSize["placement"],
  role: WireStandInSize["role"] = "smaller",
): WireStandInSize {
  return {
    fidelity,
    role,
    record_id: placement === "missing" ? null : `r${fidelity}`,
    type: "image/avif",
    size_bytes: fidelity * 100,
    placement,
    ...(placement === "here" ? { url: `http://127.0.0.1/data/files/t${fidelity}` } : {}),
  };
}

function summary(sizes: WireStandInSize[]): WireStandInSummary {
  return { category: "image", fidelity: 6000, status: "archivable", top: 4272, sizes };
}

describe("chooseResidentSize", () => {
  it("takes the largest resident size at or below 2560", () => {
    const chosen = chooseResidentSize(
      summary([size(640, "here"), size(1280, "here"), size(2560, "here"), size(4272, "here", "canonical")]),
    );
    expect(chosen?.fidelity).toBe(2560);
  });

  it("ignores sizes that sit in the cloud or do not exist", () => {
    const chosen = chooseResidentSize(
      summary([size(640, "here"), size(1280, "missing"), size(2560, "cloud"), size(4272, "cloud", "canonical")]),
    );
    expect(chosen?.fidelity).toBe(640);
  });

  it("takes the smallest resident size above 2560 when nothing smaller is here", () => {
    const chosen = chooseResidentSize(
      summary([size(2560, "cloud"), size(4272, "here", "canonical")]),
    );
    expect(chosen?.fidelity).toBe(4272);
  });

  it("reads a small original imported here as itself", () => {
    const chosen = chooseResidentSize({
      category: "image",
      fidelity: 2000,
      status: "self-canonical",
      top: 2000,
      sizes: [size(1280, "missing"), size(2000, "here", "original")],
    });
    expect(chosen).toMatchObject({ fidelity: 2000, role: "original" });
  });

  it("answers null when nothing is here", () => {
    expect(chooseResidentSize(summary([size(2560, "cloud")]))).toBeNull();
    expect(chooseResidentSize(undefined)).toBeNull();
    expect(
      chooseResidentSize({ category: "image", fidelity: null, status: "fidelity-unknown", top: null, sizes: [] }),
    ).toBeNull();
  });
});

describe("fetchResidentImage", () => {
  it("reads the summary with resident URLs and fetches only a local token", async () => {
    const fetchData = vi.fn(async (_path: string) =>
      Response.json({ records: [{ id: "orig", stand_ins: summary([size(1280, "here"), size(2560, "here")]) }] }),
    );
    const fetchUrl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const image = await fetchResidentImage(fetchData, "orig", fetchUrl);

    expect(image).toMatchObject({ sourceRecordId: "r2560", fidelity: 2560 });
    expect([...image!.bytes]).toEqual([1, 2, 3]);
    expect(fetchData).toHaveBeenCalledTimes(1);
    const path = fetchData.mock.calls[0]![0];
    expect(path).toContain("include=stand-in-urls");
    expect(path).not.toContain("file-url");
    expect(fetchUrl).toHaveBeenCalledWith("http://127.0.0.1/data/files/t2560");
  });

  it("fetches nothing when no size is here", async () => {
    const fetchData = async () =>
      Response.json({ records: [{ id: "orig", stand_ins: summary([size(2560, "cloud")]) }] });
    const fetchUrl = vi.fn();
    expect(await fetchResidentImage(fetchData, "orig", fetchUrl)).toBeNull();
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("throws on a failed record read, so the scan counts a failure", async () => {
    await expect(fetchResidentImage(async () => new Response("", { status: 500 }), "orig")).rejects.toThrow(
      /500/,
    );
  });
});

describe("scaleBox", () => {
  it("moves a box to an image of another size", () => {
    expect(scaleBox([560, 400, 60, 60], 0.5)).toEqual([280, 200, 30, 30]);
  });
});
