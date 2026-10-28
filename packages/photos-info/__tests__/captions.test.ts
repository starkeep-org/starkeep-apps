import { describe, expect, it } from "vitest";
import { MAX_CAPTION_LENGTH, captionValue, photosSyncableSchema } from "../src/index";

describe("captionValue", () => {
  it("stores null for an empty caption, so the row keeps its other columns", () => {
    expect(captionValue("")).toBeNull();
  });

  it("stores a caption up to the limit as typed", () => {
    expect(captionValue("A cat")).toBe("A cat");
    expect(captionValue("x".repeat(MAX_CAPTION_LENGTH))).toHaveLength(MAX_CAPTION_LENGTH);
  });

  it("refuses a caption over the limit", () => {
    expect(() => captionValue("x".repeat(MAX_CAPTION_LENGTH + 1))).toThrow(RangeError);
  });
});

describe("photosSyncableSchema", () => {
  it("is the manifest's block, with the caption table and its columns", () => {
    const enriched = photosSyncableSchema.tables.find((t) => t.name === "image_enriched");
    expect(enriched?.columns.map((c) => c.name)).toEqual([
      "record_id",
      "caption",
      "title",
      "date_taken_override",
    ]);
    expect(enriched?.columns.find((c) => c.primaryKey)?.name).toBe("record_id");
  });
});
