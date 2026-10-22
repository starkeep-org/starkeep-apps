/**
 * Records and library items for component tests.
 */
import { createDataRecord, createHLCClock, type DataRecord } from "@starkeep/protocol-primitives";
import type { LibraryItem } from "../src/library";

const clock = createHLCClock({ nodeId: "phone" });
let seq = 0;

export function photoRecord(overrides: { contentHash?: string | null } = {}): DataRecord {
  seq += 1;
  const record = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: String(seq).padStart(64, "0"),
      objectStorageKey: `shared/image/${seq}`,
      mimeType: "image/jpeg",
      sizeBytes: 2_400_000,
      originalFilename: `PXL_${seq}.jpg`,
    },
    clock,
  );
  return "contentHash" in overrides
    ? ({ ...record, contentHash: overrides.contentHash } as DataRecord)
    : record;
}

/** A photograph as the grid's tile has it, or as a resolve returns it. */
export function libraryItem(
  record: DataRecord,
  overrides: Partial<Omit<LibraryItem, "record">> = {},
): LibraryItem {
  return {
    record,
    uri: `file:///tile/${record.id}.avif`,
    bytesHere: true,
    playbackUri: null,
    durationMs: null,
    hasMotion: false,
    thumbHash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    missingRendition: null,
    paintedRendition: null,
    renditionTarget: null,
    ...overrides,
  };
}
