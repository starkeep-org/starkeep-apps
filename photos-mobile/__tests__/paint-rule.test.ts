/**
 * Which rendition a surface paints, and which one it goes and gets.
 *
 * ## The distinction under test
 *
 * A rendition's *record* and a rendition's *bytes* are two different things on
 * this device, and the resolution rule shared with the web app only knows about
 * the first. Metadata sync brings a rung's row down long before its blob
 * follows — often without one ever following — so `RenditionChoice.available`
 * means "this rung exists somewhere", which is the wrong question for a phone
 * deciding what to draw.
 *
 * So the page resolves twice over the same candidates: once over everything it
 * knows about, which names the rung to fetch, and once over the resident subset,
 * which names the rung to paint. Everything below is about that pair.
 *
 * ## The paint order, and the one rule with teeth
 *
 * 1. the ideal rung, when its bytes are here;
 * 2. otherwise the largest resident rung **strictly below** the ideal;
 * 3. otherwise the record's own original, when that is here;
 * 4. otherwise nothing — the tile paints its ThumbHash.
 *
 * The rule worth a test of its own is that a resident rung *above* the ideal is
 * never chosen. It is easy to write code that would: the resident set is right
 * there, and picking the closest match from it looks like an improvement.
 * `rendition-resolution.ts` sets out why it is not — reaching upward fetches the
 * expensive thing first, and under Intelligent-Tiering it promotes exactly the
 * large objects tiering exists to keep cold — and on this device it also costs
 * the decode the rendition was chosen to avoid.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createDataRecord,
  createHLCClock,
  type DataRecord,
  type StarkeepId,
} from "@starkeep/protocol-primitives";
import { MockDatabaseAdapter, type ObjectStorageAdapter } from "@starkeep/storage-adapter";
import { listLibrary, resolveForViewer, type LibraryDeps } from "../src/library";

const clock = createHLCClock({ nodeId: "phone" });

/**
 * A source big enough that every rung of the still ladder applies.
 *
 * 4272 is the ladder's top class maximum, so a source at least that long makes
 * all five rungs applicable and none of them clamp. That keeps every case below
 * about the *rule* rather than about which rungs happened to exist for a small
 * photograph — a distinction `applicableStillClasses` makes and this file
 * deliberately does not exercise.
 */
const SOURCE = { width: 4272, height: 2848 };

/**
 * A phone, in layout points and pixels.
 *
 * Deliberately concrete rather than derived from a device: the point of the
 * cases below is that a *given* geometry resolves to a *given* rung, and a
 * geometry that moved with the test runner would assert nothing.
 */
// `LIBRARY_ROW_HEIGHT`'s value, restated rather than imported: `theme.ts` pulls
// in React Native, which does not parse under Node. Restating it is also the
// more honest fixture — these cases assert that *this* geometry lands on *that*
// rung, and one that moved with the theme would assert nothing.
const GRID = { targetRowHeight: 120, containerWidth: 350, devicePixelRatio: 3 };
const SCREEN = { width: 390, height: 844 };

let database: MockDatabaseAdapter;
let held: Set<string>;

const objectStorage = {
  localFileUriFor: (key: string) => (held.has(key) ? `file:///objects/${key}` : null),
} as unknown as ObjectStorageAdapter;

function deps(): LibraryDeps {
  return { database, objectStorage, aliases: null };
}

let seq = 0;

function keyFor(name: string): string {
  return `shared/image/${name}`;
}

/** A record with stored dimensions, and its bytes optionally on this device. */
async function seedParent(options: {
  readonly bytesHere: boolean;
  readonly dimensions?: { width: number; height: number } | null;
}): Promise<DataRecord> {
  seq += 1;
  const key = keyFor(`parent-${seq}`);
  const record = createDataRecord(
    {
      type: "image/jpeg",
      originAppId: "photos",
      contentHash: String(seq).padStart(64, "0"),
      objectStorageKey: key,
      sizeBytes: 4_000_000,
      originalFilename: `photo-${seq}.jpg`,
    },
    clock,
  );
  await database.put(record);
  const dimensions = options.dimensions === undefined ? SOURCE : options.dimensions;
  if (dimensions) {
    await database.putMetadata("image", {
      recordId: record.id,
      width: dimensions.width,
      height: dimensions.height,
    });
  }
  if (options.bytesHere) held.add(key);
  return record;
}

/**
 * A rendition child at one rung, present as a record and optionally as bytes.
 *
 * The two flags are the whole point of the fixture. `resident: false` is the
 * ordinary state of a rung that arrived by metadata sync, and it is the state
 * `RenditionChoice.available` cannot see.
 */
async function seedRendition(
  parent: DataRecord,
  longEdge: number,
  options: { readonly resident: boolean },
): Promise<DataRecord> {
  seq += 1;
  const key = keyFor(`rendition-${longEdge}-${seq}`);
  const record = createDataRecord(
    {
      type: "image/avif",
      originAppId: "photos",
      parentId: parent.id,
      contentHash: String(seq).padStart(64, "1"),
      objectStorageKey: key,
      sizeBytes: longEdge * 100,
      originalFilename: null,
    },
    clock,
  );
  await database.put(record);
  await database.putMetadata("image", {
    recordId: record.id,
    width: longEdge,
    height: Math.round((longEdge * SOURCE.height) / SOURCE.width),
  });
  // The label is what makes this a *rendition* rather than any other child.
  // `loadVariantCandidatesForPage` filters on it, and a crop with a parent would
  // otherwise be offered as an answer to a pixel request.
  await database.upsertLabels([
    {
      recordId: record.id,
      appId: "photos",
      key: "rendition",
      value: String(longEdge),
      recordType: record.type,
      hlc: clock.now(),
    },
  ]);
  if (options.resident) held.add(key);
  return record;
}

/** The one item of a one-record page. */
async function tile() {
  const page = await listLibrary(deps(), { limit: 10, grid: GRID });
  return page.items[0]!;
}

function uriOf(record: DataRecord | null): string | null {
  return record?.objectStorageKey ? `file:///objects/${record.objectStorageKey}` : null;
}

beforeEach(async () => {
  database = new MockDatabaseAdapter();
  await database.init();
  held = new Set();
  seq = 0;
});

describe("what a tile paints", () => {
  it("paints the ideal rung when its bytes are here", async () => {
    const parent = await seedParent({ bytesHere: true });
    // Everything, resident. The ideal for this geometry is what gets picked, and
    // the smaller rungs beside it are what make that a choice rather than the
    // only option.
    const xsmall = await seedRendition(parent, 320, { resident: true });
    const thumb = await seedRendition(parent, 640, { resident: true });

    const item = await tile();

    // A 120-point row at 3x is 360 physical pixels for a landscape photograph
    // laid out at its own shape, which snaps to the 640 rung.
    expect(item.paintedRendition).toBe(thumb.id);
    expect(item.uri).toBe(uriOf(thumb));
    expect(item.paintedRendition).not.toBe(xsmall.id);
    // Nothing to fetch: the rung it wants is the rung it has.
    expect(item.missingRendition).toBeNull();
  });

  it("paints the largest resident rung below the ideal, and asks for the ideal", async () => {
    const parent = await seedParent({ bytesHere: true });
    const xsmall = await seedRendition(parent, 320, { resident: true });
    const thumb = await seedRendition(parent, 640, { resident: false });

    const item = await tile();

    expect(item.paintedRendition).toBe(xsmall.id);
    expect(item.uri).toBe(uriOf(xsmall));
    // The half that used to be missing entirely: the phone resolved which rung
    // it wanted, found the bytes absent, and never asked for them.
    expect(item.missingRendition).toBe(thumb.id);
  });

  it("never paints a resident rung above the ideal", async () => {
    const parent = await seedParent({ bytesHere: true });
    // The ideal is 640 and it is not here. Everything *above* it is — which is
    // the shape of a library synced from a node that derived the big rungs
    // first, and the shape that makes reaching upward tempting.
    const thumb = await seedRendition(parent, 640, { resident: false });
    const medium = await seedRendition(parent, 1280, { resident: true });
    const screen = await seedRendition(parent, 2560, { resident: true });

    const item = await tile();

    expect(item.paintedRendition).not.toBe(medium.id);
    expect(item.paintedRendition).not.toBe(screen.id);
    // Nothing below the ideal is resident either, so the tile paints its
    // placeholder — and notably *not* the original, which is right here. The
    // list refuses that decode; see `library.ts`'s header.
    expect(item.paintedRendition).toBeNull();
    expect(item.uri).toBeNull();
    expect(item.bytesHere).toBe(true);
    expect(item.missingRendition).toBe(thumb.id);
  });

  it("paints no picture when no rung is resident, even holding the original", async () => {
    // **The case the list's rule is entirely about.** The original is on this
    // device and the tile still refuses it: filling a 200 pt box from a
    // 12-megapixel camera-roll JPEG is the decode the ladder exists to remove,
    // and a grid pays it per tile per scroll.
    //
    // `bytesHere` stays true, because "can this device show the full-size file"
    // and "what does this tile paint" are different questions — the viewer and
    // the fetch control both read the first one.
    const parent = await seedParent({ bytesHere: true });
    await seedRendition(parent, 640, { resident: false });

    const item = await tile();

    expect(item.paintedRendition).toBeNull();
    expect(item.uri).toBeNull();
    expect(item.bytesHere).toBe(true);
  });

  it("paints nothing when neither a rung nor the original is here", async () => {
    // The state the ThumbHash exists for. A null `uri` is the tile's cue to
    // paint its placeholder, and the plan's floor is that there is always one.
    const parent = await seedParent({ bytesHere: false });
    await seedRendition(parent, 640, { resident: false });

    const item = await tile();

    expect(item.uri).toBeNull();
    expect(item.bytesHere).toBe(false);
    expect(item.paintedRendition).toBeNull();
    expect(item.missingRendition).not.toBeNull();
  });

  it("asks for nothing when the ideal rung has never been derived", async () => {
    // No rendition records at all — this device's own camera roll before
    // anything has derived a ladder. There is nothing to *fetch*, because a
    // fetch moves bytes and does not commission work.
    //
    // This exact shape — nothing painted, nothing missing, the bytes here — is
    // what `use-library`'s page effect reads as "derive this one now", and it
    // is the state that made the grid decode originals for as long as nothing
    // acted on it. See `deriveForRecord`.
    const parent = await seedParent({ bytesHere: true });

    const item = await tile();

    expect(item.missingRendition).toBeNull();
    expect(item.paintedRendition).toBeNull();
    expect(item.uri).toBeNull();
    expect(item.bytesHere).toBe(true);
  });

  it("resolves nothing at all when no grid geometry is given", async () => {
    // Resolving against an unmeasured container would pin every record on the
    // page to the bottom rung, so a caller with no geometry gets no resolution.
    //
    // It now also gets no picture, which is the honest consequence rather than a
    // regression: a caller that has not said how big its boxes are cannot be
    // handed the original as a consolation, because the original is precisely
    // what this surface refuses. Every production caller passes a geometry —
    // `gridGeometry()` reads the window, which is never zero.
    const parent = await seedParent({ bytesHere: true });
    await seedRendition(parent, 640, { resident: true });

    const page = await listLibrary(deps(), { limit: 10 });

    expect(page.items[0]!.paintedRendition).toBeNull();
    expect(page.items[0]!.missingRendition).toBeNull();
    expect(page.items[0]!.uri).toBeNull();
    expect(page.items[0]!.bytesHere).toBe(true);
  });
});

describe("the viewer wants a bigger rung than the tile", () => {
  it("resolves a larger ideal for the same record on the same device", async () => {
    const parent = await seedParent({ bytesHere: true });
    const thumb = await seedRendition(parent, 640, { resident: true });
    const medium = await seedRendition(parent, 1280, { resident: true });

    const item = await tile();
    const opened = await resolveForViewer(deps(), item, {
      screen: SCREEN,
      devicePixelRatio: 3,
    });

    // The tile wants a couple of hundred pixels and the viewer wants a screen's
    // worth. This is the difference the viewer used to not have at all — it
    // painted whatever the grid had already chosen, so a full-screen photograph
    // showed a 640-pixel rendition.
    //
    // 1280 rather than the top of the ladder, and the arithmetic is worth
    // stating because it is the plan's own table: a 390x844 screen less 160
    // points of chrome is 684 points of height, a 3:2 photograph fits that on
    // its width at 390 points, and 390 at 3x is 1170 physical pixels — which
    // snaps up to 1280.
    expect(item.paintedRendition).toBe(thumb.id);
    expect(opened.paintedRendition).toBe(medium.id);
    expect(opened.uri).toBe(uriOf(medium));
  });

  it("wants a bigger rung for a portrait than for a landscape on the same screen", async () => {
    // The reason the target is per record rather than per screen. A portrait
    // photograph fits the *height* of a phone, so it is drawn nearly twice as
    // large as a landscape one — and asks for the rung above.
    const portrait = await seedParent({
      bytesHere: true,
      dimensions: { width: SOURCE.height, height: SOURCE.width },
    });
    await seedRendition(portrait, 1280, { resident: true });
    const screen = await seedRendition(portrait, 2560, { resident: true });

    const opened = await resolveForViewer(deps(), await tile(), {
      screen: SCREEN,
      devicePixelRatio: 3,
    });

    expect(opened.paintedRendition).toBe(screen.id);
  });

  it("reports the viewer's own missing rung, not the tile's", async () => {
    const parent = await seedParent({ bytesHere: false });
    // The tile's rung is here; the viewer's is not. So the same record is
    // complete for the grid and incomplete for the screen, which is exactly why
    // the viewer has to resolve for itself.
    const thumb = await seedRendition(parent, 640, { resident: true });
    const medium = await seedRendition(parent, 1280, { resident: false });

    const item = await tile();
    const opened = await resolveForViewer(deps(), item, {
      screen: SCREEN,
      devicePixelRatio: 3,
    });

    expect(item.missingRendition).toBeNull();
    expect(opened.missingRendition).toBe(medium.id);
    // Painting the rung it does have meanwhile, which is rule 2 at the viewer's
    // target rather than the tile's.
    expect(opened.paintedRendition).toBe(thumb.id);
  });

  it("keeps the record's own bytes reported as absent when they are", async () => {
    // The viewer's fetch control is offered on `bytesHere`, and a rendition
    // standing in for an absent original must not suppress it. This is the case
    // that used to hide the control behind a non-null `uri`.
    const parent = await seedParent({ bytesHere: false });
    await seedRendition(parent, 1280, { resident: true });

    const opened = await resolveForViewer(deps(), await tile(), {
      screen: SCREEN,
      devicePixelRatio: 3,
    });

    expect(opened.uri).not.toBeNull();
    expect(opened.bytesHere).toBe(false);
  });
});

describe("a record whose dimensions nothing has read", () => {
  it("still gets a box, a target and a resolution", async () => {
    // Mid-backfill, which is an ordinary state on this device: the EXIF pass
    // repairs a library in batches, and the grid has to render while it does.
    const parent = await seedParent({ bytesHere: true, dimensions: null });
    await seedRendition(parent, 640, { resident: true });

    const item = await tile();

    // The mild landscape guess, shared with the web app's grid so the two lay a
    // dimensionless record out the same way.
    expect(item.aspect).toBeCloseTo(1.5, 6);
    // And it resolves rather than being excluded — over what exists, since
    // without a source long edge there is no applicable set to name an ideal
    // from.
    expect(item.uri).not.toBeNull();
  });
});

describe("orientation", () => {
  it("lays a quarter-turned photograph out in the shape it is shown", async () => {
    // The media store's own width and height carry no rotation correction, which
    // is why `media/exif.ts` reads the header. A grid that used the stored pair
    // would give a portrait photograph a landscape box.
    const parent = await seedParent({ bytesHere: true });
    await database.putMetadata("image", { recordId: parent.id as StarkeepId, orientation: 6 });

    const item = await tile();

    expect(item.aspect).toBeCloseTo(SOURCE.height / SOURCE.width, 6);
  });
});
