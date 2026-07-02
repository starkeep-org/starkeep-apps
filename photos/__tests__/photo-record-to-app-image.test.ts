/**
 * Tests for photoRecordToAppImage — the read-side mapper that assembles an
 * AppImage from a data record plus its (optional) shared image-metadata row and
 * (optional) enriched user fields. The width/height default of 0 when no
 * metadata row exists is the signal the Info panel uses to trigger lazy
 * backfill, so it's pinned here alongside the EXIF/enriched mapping.
 */
import { describe, it, expect } from "vitest";
import { photoRecordToAppImage } from "../src/lib/photoRecordToAppImage";
import type { PhotoRecord, PhotoMetadataRow, ImageEnriched } from "../src/lib/data-server-client";

function record(overrides: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    id: "REC",
    type: "image",
    mime_type: "image/jpeg",
    size_bytes: 1234,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    sync_status: "synced",
    content_hash: "abc",
    object_storage_key: "shared/image/ab/abc",
    original_filename: "photo.jpg",
    parent_id: null,
    ...overrides,
  };
}

describe("photoRecordToAppImage", () => {
  it("maps dimensions and EXIF from the metadata row", () => {
    const meta: PhotoMetadataRow = {
      recordId: "REC",
      width: 4000,
      height: 3000,
      camera_make: "Acme",
      camera_model: "Snapper X",
      f_number: 2.8,
      iso: 100,
      orientation: 6,
      captured_at: "2024-01-01T12:00:00",
    };

    const img = photoRecordToAppImage(record(), meta);

    expect(img.width).toBe(4000);
    expect(img.height).toBe(3000);
    expect(img.exif.cameraMake).toBe("Acme");
    expect(img.exif.fNumber).toBe(2.8);
    expect(img.exif.orientation).toBe(6);
    // captured_at drives the effective date when present.
    expect(img.effectiveDateTaken).toBe("2024-01-01T12:00:00");
  });

  it("defaults dimensions to 0 when there is no metadata row (backfill signal)", () => {
    const img = photoRecordToAppImage(record(), null);

    expect(img.width).toBe(0);
    expect(img.height).toBe(0);
    expect(img.exif.cameraMake).toBeNull();
    expect(img.exif.orientation).toBeNull();
    // With no captured_at, the effective date falls back to the record's createdAt.
    expect(img.effectiveDateTaken).toBe("2024-01-01T00:00:00Z");
  });

  it("carries enriched title/caption and prefers a date-taken override", () => {
    const enriched: ImageEnriched = {
      record_id: "REC",
      caption: "at the beach",
      title: "Sunset",
      date_taken_override: "2020-06-01T09:00:00",
    };

    const img = photoRecordToAppImage(record(), { recordId: "REC", captured_at: "2024-01-01T12:00:00" }, enriched);

    expect(img.title).toBe("Sunset");
    expect(img.caption).toBe("at the beach");
    // An explicit override wins over captured_at.
    expect(img.effectiveDateTaken).toBe("2020-06-01T09:00:00");
  });

  it("falls back to the record id for a missing filename", () => {
    const img = photoRecordToAppImage(record({ original_filename: null }), null);
    expect(img.originalFilename).toBe("REC");
  });
});
