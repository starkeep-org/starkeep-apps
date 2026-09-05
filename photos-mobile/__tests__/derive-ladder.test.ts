/**
 * The phone making its own renditions.
 *
 * ## What is worth asserting here, and what is not
 *
 * The encode is native and is stubbed. Everything above it is not, and it is
 * where the failures live: which rungs a record is missing, what a rung is
 * called and where its bytes go, the order the four writes happen in, and how a
 * sweep that is stopped resumes. All of that decides whether a rendition is
 * visible to the resolution rule on this device and on every node it syncs to.
 *
 * The two rules with the sharpest teeth get cases of their own:
 *
 *  - **Nothing above `image-medium`.** That ceiling is what keeps the archive
 *    gate safe without a new rule — a record whose original exceeds it still has
 *    missing rungs, so `ladderIsComplete` stays false and the original stays out
 *    of deep archive until a node running `sharp` finishes the ladder. A phone
 *    that quietly derived the top rungs would satisfy the gate with files it
 *    never made.
 *  - **The label's timestamp is strictly after the record's.** A round cut moves
 *    in whole timestamps, so a label sharing its record's can be shipped without
 *    it — which is not hypothetical: `round-cut.ts` records a handset found
 *    holding rendition records whose label had been cut away, invisible to the
 *    grid and unclassifiable to residency.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  compareHLC,
  createDataRecord,
  createHLCClock,
  dataRecordObjectKey,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import {
  MockDatabaseAdapter,
  MockObjectStorageAdapter,
  type RawDatabase,
} from "@starkeep/storage-adapter";
import { createSqliteMediaAliasStore, type MediaAliasStore } from "../src/media/media-alias";
import {
  createSqliteScanCursorStore,
  DERIVATION_CURSOR_TABLE,
  type ScanCursorStore,
} from "../src/work/scan-cursor";
import {
  deriveForRecord,
  derivePage,
  deriveRenditions,
  DERIVE_PAGE_LIMIT,
  MOBILE_DERIVE_CEILING_LONG_EDGE,
  type DecodedSource,
  type DeriveLadderDeps,
  type ImageEncoder,
} from "../src/photos/derive-ladder";

const clock = createHLCClock({ nodeId: "phone" });
const hash = async (bytes: Uint8Array): Promise<string> =>
  createHash("sha256").update(bytes).digest("hex");

function rawDb(): RawDatabase {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...(p as never[])),
        get: (...p: unknown[]) => stmt.get(...(p as never[])),
        all: (...p: unknown[]) => stmt.all(...(p as never[])),
      };
    },
  };
}

let aliases: MediaAliasStore;
let database: MockDatabaseAdapter;
let objectStorage: MockObjectStorageAdapter;
let cursor: ScanCursorStore;
let seq = 0;

/**
 * An encoder that answers, and records everything it was asked.
 *
 * The bytes it produces are distinct per rung, because a content-addressed key
 * is the hash of the bytes: an encoder returning the same buffer for every rung
 * would mint one record for the whole ladder and every case below would pass for
 * the wrong reason.
 */
function fakeEncoder(
  options: {
    readonly undecodable?: ReadonlySet<string>;
    /**
     * The decode cap this encoder expects to be handed.
     *
     * Defaults to the sweep's, which is what every case that does not raise it
     * asserts. `deriveForRecord` takes the ceiling as an argument now, so a case
     * that raises it says so here and the assertion moves with it rather than
     * being switched off.
     */
    readonly ceiling?: number;
  } = {},
) {
  const decoded: string[] = [];
  const decodedAt: number[] = [];
  const encodes: { uri: string; maxLongEdge: number; quality: number }[] = [];
  let released = 0;
  let live = 0;
  let maxLive = 0;

  const encode: ImageEncoder = async (uri, ceiling) => {
    decoded.push(uri);
    decodedAt.push(ceiling);
    if (options.undecodable?.has(uri)) return null;
    live += 1;
    maxLive = Math.max(maxLive, live);
    const source: DecodedSource = {
      async encode(maxLongEdge, quality) {
        encodes.push({ uri, maxLongEdge, quality });
        return {
          bytes: Uint8Array.from(
            `${uri}@${maxLongEdge}`.split("").map((c) => c.charCodeAt(0) % 256),
          ),
          width: maxLongEdge,
          // A 3:2 landscape, so a rung's stored dimensions are a shape rather
          // than a square nothing in a real library is.
          height: Math.round((maxLongEdge * 2) / 3),
        };
      },
      release() {
        released += 1;
        live -= 1;
      },
    };
    // The ceiling the pass decodes at, asserted here rather than in every case.
    expect(ceiling).toBe(options.ceiling ?? MOBILE_DERIVE_CEILING_LONG_EDGE);
    return source;
  };

  return {
    encode,
    decoded,
    decodedAt,
    encodes,
    get released(): number {
      return released;
    },
    /** The most bitmaps held at once — one, if every decode is released. */
    get maxLive(): number {
      return maxLive;
    },
  };
}

function deps(
  encode: ImageEncoder,
  over: Partial<DeriveLadderDeps> = {},
): DeriveLadderDeps & { cursor: ScanCursorStore } {
  return { aliases, database, objectStorage, clock, hash, encode, cursor, ...over };
}

/**
 * A photograph this device imported: a record, its dimensions, and the alias
 * saying its bytes are in the camera roll.
 *
 * The alias is what the sweep walks, so a record without one is a record this
 * pass will never see — which is the intended behaviour for anything that
 * arrived by sync.
 */
async function importOriginal(
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly dimensions?: boolean;
    readonly type?: string;
  } = {},
): Promise<DataRecord> {
  seq += 1;
  const width = options.width ?? 4000;
  const height = options.height ?? 3000;
  const type = options.type ?? "image/jpeg";
  const contentHash = String(seq).padStart(64, "a");
  const record = createDataRecord(
    {
      type,
      originAppId: "photos",
      contentHash,
      objectStorageKey: dataRecordObjectKey(type, contentHash),
      sizeBytes: 4_000_000,
      originalFilename: `IMG_${seq}.jpg`,
    },
    clock,
  );
  await database.put(record);
  if (options.dimensions !== false) {
    await database.putMetadata(type.startsWith("video") ? "video" : "image", {
      recordId: record.id,
      width,
      height,
    });
  }
  aliases.add({
    objectStorageKey: record.objectStorageKey,
    recordId: record.id,
    contentUri: `content://media/external/images/media/${seq}`,
    assetId: String(seq),
    sizeBytes: record.sizeBytes,
    contentType: null,
    modificationTimeMs: 1_700_000_000_000 + seq,
    addedAtMs: 1_700_000_000_000,
  });
  return record;
}

/** Every rendition child of a record, by the label value that names its rung. */
async function rungsOf(parent: DataRecord): Promise<Map<string, DataRecord>> {
  const children = await database.query({
    filters: [{ field: "parentId", operator: "eq", value: parent.id }],
    limit: 50,
  });
  const labels = await database.getLabelsByRecordIds(children.records.map((c) => c.id));
  const out = new Map<string, DataRecord>();
  for (const child of children.records) {
    const label = (labels.get(child.id) ?? []).find(
      (l) => !l.deletedAt && l.appId === "photos" && l.key === "rendition",
    );
    if (label) out.set(label.value, child);
  }
  return out;
}

async function dimensionsOf(record: DataRecord): Promise<{ width: unknown; height: unknown }> {
  const rows = await database.getMetadataByIds("image", [record.id]);
  const row = rows.get(record.id);
  return { width: row?.["width"], height: row?.["height"] };
}

beforeEach(async () => {
  aliases = createSqliteMediaAliasStore({ db: rawDb() });
  cursor = createSqliteScanCursorStore({ db: rawDb(), table: DERIVATION_CURSOR_TABLE });
  database = new MockDatabaseAdapter();
  await database.init();
  objectStorage = new MockObjectStorageAdapter();
  seq = 0;
});

describe("which rungs a phone makes", () => {
  it("derives every applicable rung up to the ceiling and none above it", async () => {
    const parent = await importOriginal({ width: 4000, height: 3000 });
    const encoder = fakeEncoder();

    const outcome = await derivePage(deps(encoder.encode), { limit: 10 });

    expect(outcome.scanned).toBe(1);
    expect(outcome.written).toBe(3);
    expect(outcome.failed).toBe(0);
    const rungs = await rungsOf(parent);
    expect([...rungs.keys()].sort()).toEqual(["image-medium", "image-thumb", "image-xsmall"]);
    // The two above the ceiling are a `sharp` node's work, and their absence is
    // what keeps this record out of deep archive until one does it.
    expect(rungs.has("image-screen")).toBe(false);
    expect(rungs.has("image-large")).toBe(false);
  });

  it("decodes once for the whole ladder and releases the bitmap", async () => {
    await importOriginal();
    const encoder = fakeEncoder();

    await derivePage(deps(encoder.encode), { limit: 10 });

    expect(encoder.decoded).toHaveLength(1);
    expect(encoder.encodes).toHaveLength(3);
    expect(encoder.released).toBe(1);
  });

  it("never upscales: a small original clamps its top rung to its own size", async () => {
    // 900 px makes `image-medium` applicable — the original exceeds
    // `image-thumb`'s 640 — but the class is a maximum, so it emits 900.
    const parent = await importOriginal({ width: 900, height: 600 });
    const encoder = fakeEncoder();

    await derivePage(deps(encoder.encode), { limit: 10 });

    expect(encoder.encodes.map((e) => e.maxLongEdge)).toEqual([320, 640, 900]);
    expect(await dimensionsOf((await rungsOf(parent)).get("image-medium")!)).toEqual({
      width: 900,
      height: 600,
    });
  });

  it("makes only the bottom rung for an original smaller than the second", async () => {
    await importOriginal({ width: 300, height: 200 });
    const encoder = fakeEncoder();

    const outcome = await derivePage(deps(encoder.encode), { limit: 10 });

    expect(outcome.written).toBe(1);
    expect(encoder.encodes.map((e) => e.maxLongEdge)).toEqual([300]);
  });

  it("leaves a video alone", async () => {
    await importOriginal({ type: "video/mp4" });
    const encoder = fakeEncoder();

    const outcome = await derivePage(deps(encoder.encode), { limit: 10 });

    // A poster is a frame extraction and a skim is a transcode. Neither is an
    // AVIF encode of a decoded still, so neither belongs in this pass.
    expect(outcome.scanned).toBe(0);
    expect(encoder.decoded).toEqual([]);
  });

  it("skips a record whose dimensions nothing has written", async () => {
    await importOriginal({ dimensions: false });
    const encoder = fakeEncoder();

    const outcome = await derivePage(deps(encoder.encode), { limit: 10 });

    // The ladder is computed against the original's long edge, and there is
    // nothing here to compute it from. Costs no decode; the EXIF backfill is
    // what repairs it.
    expect(outcome.scanned).toBe(0);
    expect(encoder.decoded).toEqual([]);
  });
});

describe("what a derived rung looks like", () => {
  it("publishes bytes, dimensions, a label and a record", async () => {
    const parent = await importOriginal({ width: 4000, height: 3000 });
    const encoder = fakeEncoder();

    await derivePage(deps(encoder.encode), { limit: 10 });

    const thumb = (await rungsOf(parent)).get("image-thumb")!;
    expect(thumb.type).toBe("image/avif");
    expect(thumb.parentId).toBe(parent.id);
    // The name every other node gives this rung. It is part of the
    // content-addressed id, so a second spelling would be a second id for the
    // same rung of the same photograph.
    expect(thumb.originalFilename).toBe(`image-thumb_${parent.originalFilename}`);
    // The key is the hash of the bytes, and the bytes are where it says.
    expect(thumb.objectStorageKey).toBe(
      dataRecordObjectKey("image/avif", thumb.contentHash),
    );
    const stored = await objectStorage.get(thumb.objectStorageKey);
    expect(stored?.data.byteLength).toBe(thumb.sizeBytes);
    expect(await hash(stored!.data)).toBe(thumb.contentHash);
    // Without these it is unorderable, which makes it invisible to resolution
    // on every node — storage nobody ever reads.
    expect(await dimensionsOf(thumb)).toEqual({ width: 640, height: 427 });
  });

  it("stamps the label strictly after the record it describes", async () => {
    const parent = await importOriginal();

    await derivePage(deps(fakeEncoder().encode), { limit: 10 });

    const thumb = (await rungsOf(parent)).get("image-thumb")!;
    const label = (await database.getLabelsByRecordIds([thumb.id])).get(thumb.id)![0]!;
    // Strictly greater, not merely not-less. A round cut moves in whole
    // timestamps, so an equal pair can be split — shipping the label and
    // deferring the record it belongs to.
    expect(compareHLC(label.updatedAt, thumb.createdAt)).toBeGreaterThan(0);
  });

  it("charges the bytes to a budget once the label is there to read", async () => {
    const parent = await importOriginal();
    const charged: { id: StarkeepId; labelled: boolean }[] = [];

    await derivePage(
      deps(fakeEncoder().encode, {
        noteDerived: async (record) => {
          const labels = (await database.getLabelsByRecordIds([record.id])).get(record.id) ?? [];
          // The class these bytes are charged to is resolved from this label.
          // Charging before it exists resolves every rung as an original.
          charged.push({ id: record.id, labelled: labels.length > 0 });
        },
      }),
      { limit: 10 },
    );

    expect(charged).toHaveLength(3);
    expect(charged.every((c) => c.labelled)).toBe(true);
    const rungs = await rungsOf(parent);
    expect(charged.map((c) => c.id).sort()).toEqual(
      [...rungs.values()].map((r) => r.id).sort(),
    );
  });
});

describe("what it does not do twice", () => {
  it("costs no decode for a record that already has every rung it can make", async () => {
    await importOriginal();
    const first = fakeEncoder();
    await derivePage(deps(first.encode), { limit: 10 });

    const second = fakeEncoder();
    const outcome = await derivePage(deps(second.encode), { limit: 10 });

    expect(outcome.scanned).toBe(0);
    expect(outcome.written).toBe(0);
    expect(second.decoded).toEqual([]);
  });

  it("makes only the rung that is missing", async () => {
    const parent = await importOriginal();
    await derivePage(deps(fakeEncoder().encode), { limit: 10 });
    // Delete one rung's record, the way an eviction of a whole record would.
    const thumb = (await rungsOf(parent)).get("image-thumb")!;
    await database.delete(thumb.id, clock.now());

    const encoder = fakeEncoder();
    const outcome = await derivePage(deps(encoder.encode), { limit: 10 });

    expect(outcome.written).toBe(1);
    expect(encoder.encodes.map((e) => e.maxLongEdge)).toEqual([640]);
  });

  it("re-derives a rung whose dimensions were never written", async () => {
    const parent = await importOriginal();
    await derivePage(deps(fakeEncoder().encode), { limit: 10 });
    const thumb = (await rungsOf(parent)).get("image-thumb")!;
    // The state an interrupted publish leaves: a record and a label, and no
    // dimensions — so variant resolution cannot order it and drops it.
    await database.putMetadata("image", { recordId: thumb.id, width: null, height: null });

    const encoder = fakeEncoder();
    const outcome = await derivePage(deps(encoder.encode), { limit: 10 });

    expect(outcome.written).toBe(1);
    // Repaired in place: the same pixels hash to the same key, so the record is
    // the same record and the write puts its dimensions back.
    expect((await rungsOf(parent)).get("image-thumb")!.id).toBe(thumb.id);
    expect(await dimensionsOf(thumb)).toEqual({ width: 640, height: 427 });
  });
});

describe("how a sweep is bounded", () => {
  it("stops at the record budget and resumes at the record it did not reach", async () => {
    for (let i = 0; i < 4; i += 1) await importOriginal();
    const first = fakeEncoder();

    const one = await deriveRenditions(deps(first.encode), { maxRecords: 2 });

    expect(one.scanned).toBe(2);
    expect(one.complete).toBe(false);
    expect(cursor.get()).not.toBeNull();

    const second = fakeEncoder();
    const two = await deriveRenditions(deps(second.encode), { maxRecords: 2 });

    expect(two.scanned).toBe(2);
    // Every record seen exactly once across the two windows: none re-decoded,
    // none skipped.
    expect(new Set([...first.decoded, ...second.decoded]).size).toBe(4);
  });

  it("resets the cursor when the walk reaches the end", async () => {
    await importOriginal();
    cursor.set("shared/image/zz/whatever");

    const outcome = await deriveRenditions(deps(fakeEncoder().encode), { maxRecords: 8 });

    // Nothing after that position, so the walk is done and the next window
    // starts over — which is what finds the rungs a new photograph needs.
    expect(outcome.complete).toBe(true);
    expect(cursor.get()).toBeNull();
  });

  it("stops between records when the window closes", async () => {
    const originals = [];
    for (let i = 0; i < 4; i += 1) originals.push(await importOriginal());
    // The walk is in object-storage-key order, which is the alias table's
    // primary key and the one column with no ties.
    const inWalkOrder = [...originals].sort((a, b) =>
      a.objectStorageKey.localeCompare(b.objectStorageKey),
    );
    const encoder = fakeEncoder();
    let decodes = 0;
    const signal = {
      get aborted(): boolean {
        // Trips once one record has been dealt with, the way a share of a
        // background window expires partway through a page.
        return decodes > 0;
      },
    };
    const counting: ImageEncoder = async (uri, ceiling) => {
      decodes += 1;
      return encoder.encode(uri, ceiling);
    };

    const outcome = await deriveRenditions(deps(counting), { maxRecords: 8, signal });

    expect(outcome.scanned).toBe(1);
    expect(outcome.complete).toBe(false);
    // The position is the record it *finished*, never the one it was about to
    // start — so the next window re-decodes nothing and skips nothing.
    expect(cursor.get()).toBe(inWalkOrder[0]!.objectStorageKey);

    const rest = fakeEncoder();
    const next = await deriveRenditions(deps(rest.encode), { maxRecords: 8 });

    expect(next.scanned).toBe(3);
    expect(next.complete).toBe(true);
  });

  it("stops at the page budget and rotates, so a derived library costs a slice per open", async () => {
    for (let i = 0; i < 6; i += 1) await importOriginal();
    await deriveRenditions(deps(fakeEncoder().encode), { maxRecords: 100 });
    const walked: (string | null)[] = [];

    // One alias per page and two pages per sweep, which is the same shape as
    // sixty-four and thirty-two against a library of thousands.
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const outcome = await deriveRenditions(deps(fakeEncoder().encode), {
        pageLimit: 1,
        maxPages: 2,
      });
      walked.push(cursor.get());
      expect(outcome.complete).toBe(false);
    }

    // Each sweep starts where the last one stopped, so the whole table is still
    // reached — a rotation rather than three repetitions of the same two rows.
    expect(new Set(walked).size).toBe(3);
    expect(walked.every((position) => position !== null)).toBe(true);
  });

  it("walks a page far larger than the record budget, so a derived library is cheap to re-walk", async () => {
    // Everything derived already, so the sweep's only cost is reading the page.
    for (let i = 0; i < 6; i += 1) await importOriginal();
    await deriveRenditions(deps(fakeEncoder().encode), { maxRecords: 100 });

    const encoder = fakeEncoder();
    const outcome = await deriveRenditions(deps(encoder.encode));

    expect(outcome.complete).toBe(true);
    expect(encoder.decoded).toEqual([]);
    expect(DERIVE_PAGE_LIMIT).toBeGreaterThan(6);
  });
});

describe("what a failure costs", () => {
  it("counts a file it cannot decode and carries on with the page", async () => {
    const first = await importOriginal();
    const second = await importOriginal();
    const bad = aliases.get(first.objectStorageKey)!.contentUri;
    const encoder = fakeEncoder({ undecodable: new Set([bad]) });

    const outcome = await derivePage(deps(encoder.encode), { limit: 10 });

    expect(outcome.failed).toBe(1);
    expect(outcome.scanned).toBe(2);
    expect((await rungsOf(first)).size).toBe(0);
    expect((await rungsOf(second)).size).toBe(3);
  });

  it("counts an encode that throws and still releases the bitmap", async () => {
    await importOriginal();
    await importOriginal();
    let seen = 0;
    const encode: ImageEncoder = async () => {
      seen += 1;
      const failing = seen === 1;
      return {
        encode: async () => {
          if (failing) throw new Error("the encoder rejected this bitmap");
          return { bytes: Uint8Array.of(1, 2, 3), width: 320, height: 213 };
        },
        release: () => {
          released += 1;
        },
      };
    };
    let released = 0;

    const outcome = await derivePage(deps(encode), { limit: 10 });

    expect(outcome.failed).toBe(1);
    // Both, including the one that threw. A bitmap of up to the ceiling on a
    // side left for the garbage collector is a phone holding several at once.
    expect(released).toBe(2);
  });
});

/**
 * Deriving one named record, because a surface is showing it.
 *
 * The sweep's counterpart, and the reason it exists is that the sweep walks
 * `object_storage_key` — a content hash — so the records it reaches bear no
 * relation to the ones on screen. Everything about *which* rungs get made is
 * shared with the sweep and asserted above; what is worth asserting here is the
 * set of things this refuses, because it is reachable per tile and every refusal
 * bounds what a scroll can cost or corrupt.
 */
describe("deriving one record on demand", () => {
  it("makes every rung the record is missing", async () => {
    const parent = await importOriginal();
    const encoder = fakeEncoder();

    const written = await deriveForRecord(deps(encoder.encode), parent);

    expect(written).toBe(3);
    expect([...(await rungsOf(parent)).keys()].sort()).toEqual([
      "image-medium",
      "image-thumb",
      "image-xsmall",
    ]);
  });

  it("decodes nothing for a record whose rungs already exist", async () => {
    const parent = await importOriginal();
    await derivePage(deps(fakeEncoder().encode), { limit: 10 });

    const encoder = fakeEncoder();
    const written = await deriveForRecord(deps(encoder.encode), parent);

    // Zero and not null: there is nothing to do, which is different from there
    // being nothing this device could ever do. The caller reads the first as
    // "fetch instead" and the second as "stop asking".
    expect(written).toBe(0);
    expect(encoder.decoded).toEqual([]);
  });

  it("refuses a record this device did not import", async () => {
    // **The rule that keeps derivation ownership where the sweep puts it.** A
    // record that arrived by sync has no alias, so its bytes are not this
    // device's to decode even when a fetch has landed them — the node holding
    // the original pays. Reachable per tile, so stated as a refusal rather than
    // left to the walk that would never have offered it.
    const parent = await importOriginal();
    aliases.remove(parent.objectStorageKey!);

    const encoder = fakeEncoder();
    const written = await deriveForRecord(deps(encoder.encode), parent);

    expect(written).toBeNull();
    expect(encoder.decoded).toEqual([]);
  });

  it("refuses a rung that already has a record, rather than minting a second", async () => {
    // **The expensive mistake this branch could make.** A rung derived on
    // another node and synced down as a row has bytes to *fetch*; re-encoding it
    // here produces different bytes, a different content hash and therefore a
    // second record for the same rung of the same photograph. The bytes being
    // absent locally is exactly the state that makes it tempting.
    const parent = await importOriginal();
    await derivePage(deps(fakeEncoder().encode), { limit: 10 });
    const rungs = await rungsOf(parent);
    for (const rung of rungs.values()) await objectStorage.delete(rung.objectStorageKey!);

    const encoder = fakeEncoder();
    const written = await deriveForRecord(deps(encoder.encode), parent);

    expect(written).toBe(0);
    expect(encoder.decoded).toEqual([]);
    expect((await rungsOf(parent)).size).toBe(3);
  });

  it("refuses a video, whose poster is a frame extraction rather than an encode", async () => {
    const clip = await importOriginal({ type: "video/mp4" });

    const encoder = fakeEncoder();

    expect(await deriveForRecord(deps(encoder.encode), clip)).toBeNull();
    expect(encoder.decoded).toEqual([]);
  });

  it("refuses a record with no stored dimensions rather than guessing them", async () => {
    // No applicable set can be computed without a source long edge, and a guess
    // would derive the wrong rungs for every panorama and every screenshot.
    // The population shrinks on its own: the EXIF backfill writes them.
    const parent = await importOriginal({ dimensions: false });

    const encoder = fakeEncoder();

    expect(await deriveForRecord(deps(encoder.encode), parent)).toBeNull();
    expect(encoder.decoded).toEqual([]);
  });

  it("answers null for a photograph this device cannot decode", async () => {
    const parent = await importOriginal();
    const alias = aliases.ofRecord(parent.id)[0]!;
    const encoder = fakeEncoder({ undecodable: new Set([alias.contentUri]) });

    expect(await deriveForRecord(deps(encoder.encode), parent)).toBeNull();
    expect((await rungsOf(parent)).size).toBe(0);
  });

  /**
   * The ceiling as an argument, which is the whole of change 2.
   *
   * A sweep and an open bound the same decode for different reasons: one runs
   * over a camera roll four records to a background window, and the other runs
   * once for the photograph on screen. So the number belongs to the caller.
   * Nothing here says anything about where the *source* comes from — it is still
   * an original this device imported, and re-encoding a rung out of a lossy
   * intermediate remains something this pass will not do.
   */
  describe("the ceiling the caller passes", () => {
    it("stops at image-medium when nothing is passed, as the sweep does", async () => {
      const parent = await importOriginal({ width: 4000, height: 3000 });
      const encoder = fakeEncoder();

      await deriveForRecord(deps(encoder.encode), parent);

      // Not `image-screen`, though a 4000 px original has one. That rung is a
      // 20 MB bitmap held through an encode, which is what the sweep cannot
      // afford over a whole library.
      expect([...(await rungsOf(parent)).keys()]).not.toContain("image-screen");
    });

    it("makes the rung a full screen wants when the viewer raises it", async () => {
      const parent = await importOriginal({ width: 4000, height: 3000 });
      const encoder = fakeEncoder({ ceiling: 2560 });

      // 2560 is `image-screen`'s maximum, which is what `viewerTarget` snaps a
      // portrait's measured need up to. The viewer passes it because that is the
      // rung its stage resolved to.
      const written = await deriveForRecord(deps(encoder.encode), parent, 2560);

      expect(written).toBe(4);
      expect([...(await rungsOf(parent)).keys()]).toContain("image-screen");
    });

    it("decodes at the ceiling it was given, not at the sweep's", async () => {
      // The cap rides through to the decode, which is where the memory is spent.
      // A raised ceiling that still decoded at 1280 would encode an
      // `image-screen` upsampled from `image-medium` pixels — the generation
      // loss this pass refuses, arrived at by accident.
      const parent = await importOriginal({ width: 4000, height: 3000 });
      const encoder = fakeEncoder({ ceiling: 2560 });

      await deriveForRecord(deps(encoder.encode), parent, 2560);

      expect(encoder.decodedAt).toEqual([2560]);
    });

    it("still refuses a rung that already has a record, however high the ceiling", async () => {
      // The rule the raised ceiling must not reach past. A rung with a record
      // wants its bytes fetched; re-encoding it here would mint a second record
      // for the same rung of the same photograph.
      const parent = await importOriginal({ width: 4000, height: 3000 });
      await deriveForRecord(deps(fakeEncoder({ ceiling: 2560 }).encode), parent, 2560);

      const encoder = fakeEncoder({ ceiling: 2560 });
      const written = await deriveForRecord(deps(encoder.encode), parent, 2560);

      expect(written).toBe(0);
      expect(encoder.decoded).toEqual([]);
    });
  });

  it("charges the rungs it makes to the budget, exactly as the sweep does", async () => {
    // The one thing a second producer of local bytes can silently get wrong.
    // Uncharged bytes are `reclaimSpace`'s `unknownKeys`, whose expected count
    // is zero, and a count that climbs with the rungs a device made is this call
    // having been skipped on one of the two paths.
    const parent = await importOriginal();
    const charged: string[] = [];

    await deriveForRecord(
      deps(fakeEncoder().encode, { noteDerived: async (r) => void charged.push(r.id) }),
      parent,
    );

    expect(charged).toHaveLength(3);
  });
});
