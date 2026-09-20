import { describe, expect, it } from "vitest";
import { acquireRenditions, compareRenditionRank, type AcquisitionEntry, PHOTOS_RUNG_SHARES, PHOTOS_FALLBACK_SHARE } from "../src";

const entry = (key: string, extra: Partial<AcquisitionEntry> = {}): AcquisitionEntry => ({
  key, sizeClass: "image-xsmall", sizeBytes: 10, resident: false,
  lastOpenedAtMs: null, recencyAtMs: 1, fetchable: true, ...extra,
});
const total = Object.values(PHOTOS_RUNG_SHARES).reduce((n, p) => n + p.share, PHOTOS_FALLBACK_SHARE.share);
const budget = (bytes: number) => bytes * total / PHOTOS_RUNG_SHARES["image-xsmall"]!.share;

describe("Photos acquisition", () => {
  it("prefetches a full offline grid over bounded ticks without downloading originals or large rungs", async () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(`thumb-${i}`));
    entries.push(entry("zoom", { sizeClass: "image-large" }));
    const landed = new Set<string>();
    for (let tick = 0; tick < 10; tick++) {
      const result = await acquireRenditions({ entries, budgetBytes: budget(400), maxBytes: 40,
        fetch: async key => { landed.add(key); return true; }, drop: async () => { throw Error("grid fits"); } });
      for (const row of entries) if (result.fetched.includes(row.key)) row.resident = true;
    }
    expect(landed.size).toBe(40);
    expect(landed.has("zoom")).toBe(false);
  });

  it("evicts never opened, then least recently opened, then older records within each rung", async () => {
    const entries = [entry("new", { resident: true, recencyAtMs: 10 }),
      entry("old", { resident: true, recencyAtMs: 1 }),
      entry("opened", { resident: true, lastOpenedAtMs: 2 }),
      entry("recently-opened", { resident: true, lastOpenedAtMs: 3 }),
      entry("other-rung", { resident: true, sizeClass: "image-thumb", sizeBytes: 1 })];
    expect([...entries.slice(0, 4)].sort(compareRenditionRank).map(e => e.key)).toEqual(["old", "new", "opened", "recently-opened"]);
    const result = await acquireRenditions({ entries, budgetBytes: budget(10), fetch: async () => true, drop: async () => true });
    expect(result.dropped).toEqual(["old", "new", "opened"]);
  });

  it("admits a request within its share and never exceeds a refused drop", async () => {
    const entries = [entry("old", { resident: true }), entry("wanted")];
    const refused = await acquireRenditions({ entries, budgetBytes: budget(10), requestedKey: "wanted",
      fetch: async () => { throw Error("cannot fit"); }, drop: async () => false });
    expect(refused.fetched).toEqual([]);
    const allowed = await acquireRenditions({ entries, budgetBytes: budget(10), requestedKey: "wanted",
      fetch: async () => true, drop: async () => true });
    expect(allowed).toEqual({ fetched: ["wanted"], dropped: ["old"] });
  });

  it("does not fetch own photographs, oversized rungs, or missing rows", async () => {
    const result = await acquireRenditions({ entries: [entry("own", { fetchable: false }), entry("huge", { sizeBytes: 11 })],
      budgetBytes: budget(10), requestedKey: "own", fetch: async () => { throw Error("must derive"); }, drop: async () => true });
    expect(result.fetched).toEqual([]);
  });

  it("does not charge failed transfers as resident or retry them within one pass", async () => {
    const attempted: string[] = [];
    await acquireRenditions({ entries: [entry("a"), entry("b")], budgetBytes: budget(20), maxBytes: 10,
      fetch: async key => { attempted.push(key); return false; }, drop: async () => true });
    expect(attempted).toEqual(["a"]);
  });
});
