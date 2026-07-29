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

  describe("derivedKind, read off Photos' own labels", () => {
    // `parent_id` says WHICH record an image came from; the label says HOW.
    // Reading `parentId !== null` as "is a thumbnail" — which the grid used to
    // do — rendered every crop as its source's thumbnail.
    it("types a thumbnail and a crop from their labels", () => {
      const thumb = photoRecordToAppImage(
        record({
          parent_id: "PARENT",
          labels: [
            { app_id: "photos", key: "thumbnail", value: "", label: "photos/thumbnail" },
          ],
        }),
        null,
      );
      expect(thumb.derivedKind).toBe("thumbnail");

      const crop = photoRecordToAppImage(
        record({
          parent_id: "PARENT",
          labels: [{ app_id: "photos", key: "crop", value: "", label: "photos/crop" }],
        }),
        null,
      );
      expect(crop.derivedKind).toBe("crop");
      // The edge itself is unchanged — the label types it, it doesn't replace it.
      expect(crop.parentId).toBe("PARENT");
    });

    it("is null for an original", () => {
      expect(photoRecordToAppImage(record({ labels: [] }), null).derivedKind).toBeNull();
    });

    it("is null when labels were not hydrated at all", () => {
      // `?include=labels` is opt-in; a list without it must not read as "no
      // record is derived" in some paths and crash in others.
      expect(photoRecordToAppImage(record(), null).derivedKind).toBeNull();
    });

    it("is null for a derived record whose label has not arrived yet", () => {
      // A record and its labels share a request but not a transaction, so this
      // state is real and transient. Treating it as "not derived" shows a
      // placeholder for a moment rather than mis-typing the edge.
      const img = photoRecordToAppImage(record({ parent_id: "PARENT", labels: [] }), null);
      expect(img.derivedKind).toBeNull();
    });

    it("ignores another app's identically-named key", () => {
      // Hydration carries every app's labels. Namespaces exist so that a
      // `crop` published by someone else is not a collision.
      const img = photoRecordToAppImage(
        record({
          parent_id: "PARENT",
          labels: [
            { app_id: "other-app", key: "crop", value: "", label: "other-app/crop" },
            { app_id: "other-app", key: "thumbnail", value: "", label: "other-app/thumbnail" },
          ],
        }),
        null,
      );
      expect(img.derivedKind).toBeNull();
    });

    it("reads Photos' label out of a mixed set", () => {
      const img = photoRecordToAppImage(
        record({
          parent_id: "PARENT",
          labels: [
            { app_id: "other-app", key: "faces-detected", value: "", label: "other-app/faces-detected" },
            { app_id: "photos", key: "thumbnail", value: "", label: "photos/thumbnail" },
          ],
        }),
        null,
      );
      expect(img.derivedKind).toBe("thumbnail");
    });
  });
});
