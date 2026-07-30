import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  classIndex,
  className,
  COCO_CLASSES,
  resolveClass,
} from "@/vision/coco-classes";
import { decodeDetections, ObjectEngine, toNchwRescaled } from "@/vision/engine/detr";
import {
  modelStatus,
  OBJECT_CLASS_COUNT,
  OBJECT_DETECTOR_MODEL,
  OBJECT_INPUT_SIZE,
  OBJECT_QUERIES,
} from "@/vision/models";
import { modelPath } from "@/vision/paths";
import { fixturePath, fixturesInstalled } from "../scripts/lib/vision-fixtures";

/**
 * The object task (plan §9).
 *
 * §9 was written against DETR-ResNet50 and this is RT-DETRv2, which differs in two
 * ways that **fail silently**. Both are the point of the integration block below:
 *
 *   1. Scores are a per-class **sigmoid** over 80 contiguous classes, not a softmax
 *      over 81 with a no-object class to drop. A softmax would still produce
 *      plausible-looking numbers — just systematically wrong ones, since it forces
 *      the 80 to sum to 1.
 *   2. Preprocessing is a **÷255 rescale only** (`do_normalize: false`), even though
 *      the config carries ImageNet mean/std it does not apply.
 *
 * The discriminating evidence is that several classes score above 0.9 on one photo
 * at once, which a softmax over 80 cannot do, and that a four-person group
 * photograph yields exactly four `person` boxes.
 */

const ready = modelStatus("objects").installed && fixturesInstalled();
/** See `vision-scene-engine.integration.test.ts` — GB-scale graphs contend. */
const MODEL_TIMEOUT_MS = 120_000;

describe("the COCO class table", () => {
  it("has exactly the number of classes the model emits", () => {
    expect(COCO_CLASSES.length).toBe(OBJECT_CLASS_COUNT);
  });

  it("round-trips names and indices", () => {
    expect(classIndex("person")).toBe(0);
    expect(className(0)).toBe("person");
    for (const [index, name] of COCO_CLASSES.entries()) {
      expect(classIndex(name)).toBe(index);
      expect(className(index)).toBe(name);
    }
  });

  it("keeps the checkpoint's own spellings", () => {
    // Order and spelling are a *model contract*: the index into this array is what
    // the model said. "Fixing" these to the more common COCO spellings would
    // relabel every stored detection without changing a byte of the model.
    expect(COCO_CLASSES[3]).toBe("motorbike");
    expect(COCO_CLASSES[4]).toBe("aeroplane");
    expect(COCO_CLASSES).toContain("tvmonitor");
    expect(COCO_CLASSES).toContain("pottedplant");
    expect(COCO_CLASSES).toContain("diningtable");
    expect(COCO_CLASSES).not.toContain("airplane");
  });

  it("has no duplicates, which would make an index unreachable", () => {
    expect(new Set(COCO_CLASSES).size).toBe(COCO_CLASSES.length);
  });

  it("returns null rather than guessing for an out-of-range index", () => {
    expect(className(-1)).toBeNull();
    expect(className(OBJECT_CLASS_COUNT)).toBeNull();
    expect(classIndex("unicorn")).toBeNull();
  });
});

describe("resolveClass", () => {
  it("matches an exact class name", () => {
    expect(resolveClass("dog")).toBe("dog");
    expect(resolveClass("hot dog")).toBe("hot dog");
  });

  it("is case- and space-insensitive", () => {
    expect(resolveClass("  DOG ")).toBe("dog");
    expect(resolveClass("Teddy Bear")).toBe("teddy bear");
  });

  it("maps the spellings people actually type", () => {
    // The checkpoint says "aeroplane"; nobody types that.
    expect(resolveClass("airplane")).toBe("aeroplane");
    expect(resolveClass("motorcycle")).toBe("motorbike");
    expect(resolveClass("tv")).toBe("tvmonitor");
    expect(resolveClass("couch")).toBe("sofa");
    expect(resolveClass("fridge")).toBe("refrigerator");
    expect(resolveClass("phone")).toBe("cell phone");
  });

  it("handles plurals, which is what counting queries are made of", () => {
    // "photos with three dogs" never contains the singular.
    expect(resolveClass("dogs")).toBe("dog");
    expect(resolveClass("people")).toBe("person");
    expect(resolveClass("persons")).toBe("person");
    expect(resolveClass("buses")).toBe("bus");
    expect(resolveClass("bicycles")).toBe("bicycle");
    expect(resolveClass("cell phones")).toBe("cell phone");
  });

  it("prefers an exact match over depluralizing, so 'skis' survives", () => {
    // `skis` is already the class name. Stripping the `s` first would look for
    // `ski`, which is not a class, and lose it.
    expect(resolveClass("skis")).toBe("skis");
  });

  it("returns null for a word that is not a class", () => {
    expect(resolveClass("beach")).toBeNull();
    expect(resolveClass("sunset")).toBeNull();
    // The failure a fuzzy matcher would introduce.
    expect(resolveClass("carpet")).toBeNull();
    expect(resolveClass("")).toBeNull();
  });
});

describe("toNchwRescaled", () => {
  it("maps 0–255 onto [0, 1] with no mean subtraction", () => {
    // The §9 divergence, as arithmetic: `do_normalize: false`. Subtracting ImageNet
    // means would put black at about −2 instead of 0.
    const black = toNchwRescaled(new Uint8Array(2 * 2 * 3).fill(0), 2);
    const white = toNchwRescaled(new Uint8Array(2 * 2 * 3).fill(255), 2);
    expect(black[0]).toBe(0);
    expect(white[0]).toBe(1);
    expect(Math.min(...black)).toBe(0);
    expect(Math.max(...white)).toBe(1);
  });

  it("de-interleaves RGB into channel planes", () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const out = toNchwRescaled(rgb, 2);
    expect([...out.slice(0, 4)]).toEqual([1, 0, 0, 1]);
    expect([...out.slice(4, 8)]).toEqual([0, 1, 0, 1]);
    expect([...out.slice(8, 12)]).toEqual([0, 0, 1, 1]);
  });

  it("rejects a buffer that is not size² × 3", () => {
    expect(() => toNchwRescaled(new Uint8Array(10), 4)).toThrow(/expected 48 bytes/);
  });
});

describe("decodeDetections", () => {
  /** `n` queries of all-negative logits, i.e. nothing detected. */
  function emptyLogits(queries: number): Float32Array {
    return new Float32Array(queries * OBJECT_CLASS_COUNT).fill(-10);
  }

  /** Sets one query's class logit to a value giving roughly `score`. */
  function setScore(logits: Float32Array, query: number, cls: number, score: number): void {
    logits[query * OBJECT_CLASS_COUNT + cls] = Math.log(score / (1 - score));
  }

  it("converts normalized cxcywh to display-pixel xywh", () => {
    // The arithmetic where a convention mistake produces plausible, wrong boxes.
    // A centred half-size box on a 1000×500 image is [250, 125, 500, 250].
    const logits = emptyLogits(1);
    setScore(logits, 0, classIndex("dog")!, 0.9);
    const boxes = Float32Array.from([0.5, 0.5, 0.5, 0.5]);

    const [only] = decodeDetections(logits, boxes, 1000, 500, 0.35);
    expect(only.bbox).toEqual([250, 125, 500, 250]);
    expect(className(only.classIndex)).toBe("dog");
    expect(only.score).toBeCloseTo(0.9, 3);
  });

  it("reads boxes as centres, not corners", () => {
    // Reading cxcywh as xywh would put this box at [100, 100, …] instead of the
    // origin — off by half its size, on every detection.
    const logits = emptyLogits(1);
    setScore(logits, 0, 0, 0.9);
    const boxes = Float32Array.from([0.1, 0.1, 0.2, 0.2]);
    const [only] = decodeDetections(logits, boxes, 1000, 1000, 0.35);
    expect(only.bbox).toEqual([0, 0, 200, 200]);
  });

  it("drops everything below the threshold", () => {
    const logits = emptyLogits(3);
    setScore(logits, 0, 0, 0.9);
    setScore(logits, 1, 1, 0.4);
    setScore(logits, 2, 2, 0.1);
    const boxes = new Float32Array(12).fill(0.5);

    expect(decodeDetections(logits, boxes, 100, 100, 0.35)).toHaveLength(2);
    expect(decodeDetections(logits, boxes, 100, 100, 0.5)).toHaveLength(1);
    expect(decodeDetections(logits, boxes, 100, 100, 0.95)).toHaveLength(0);
  });

  it("emits one detection per query, taking its best class", () => {
    // A query is one predicted object. Emitting it once per over-threshold class
    // would report the same dog as a dog *and* a cat, inflating every count — which
    // is exactly what the counting feature reads.
    const logits = emptyLogits(1);
    setScore(logits, 0, classIndex("dog")!, 0.9);
    setScore(logits, 0, classIndex("cat")!, 0.8);
    const boxes = new Float32Array(4).fill(0.5);

    const found = decodeDetections(logits, boxes, 100, 100, 0.35);
    expect(found).toHaveLength(1);
    expect(className(found[0].classIndex)).toBe("dog");
  });

  it("sorts by confidence, highest first", () => {
    const logits = emptyLogits(3);
    setScore(logits, 0, 0, 0.5);
    setScore(logits, 1, 1, 0.95);
    setScore(logits, 2, 2, 0.7);
    const boxes = new Float32Array(12).fill(0.5);
    const scores = decodeDetections(logits, boxes, 100, 100, 0.35).map((o) => o.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("clamps a box that runs past the frame", () => {
    // Legitimate for a partly-visible object, but a negative origin breaks anything
    // treating the box as a crop rectangle.
    const logits = emptyLogits(1);
    setScore(logits, 0, 0, 0.9);
    const boxes = Float32Array.from([0.05, 0.05, 0.4, 0.4]);
    const [only] = decodeDetections(logits, boxes, 100, 100, 0.35);
    expect(only.bbox[0]).toBeGreaterThanOrEqual(0);
    expect(only.bbox[1]).toBeGreaterThanOrEqual(0);
    expect(only.bbox[0] + only.bbox[2]).toBeLessThanOrEqual(100);
    expect(only.bbox[1] + only.bbox[3]).toBeLessThanOrEqual(100);
  });

  it("finds nothing in an image with nothing in it", () => {
    expect(
      decodeDetections(emptyLogits(OBJECT_QUERIES), new Float32Array(OBJECT_QUERIES * 4), 100, 100, 0.35),
    ).toEqual([]);
  });

  it("rejects mismatched tensor shapes rather than reading past the end", () => {
    expect(() => decodeDetections(new Float32Array(79), new Float32Array(4), 1, 1, 0.35)).toThrow(
      /not a multiple/,
    );
    expect(() =>
      decodeDetections(new Float32Array(OBJECT_CLASS_COUNT), new Float32Array(8), 1, 1, 0.35),
    ).toThrow(/box values/);
  });
});

describe.skipIf(!ready)("ObjectEngine on real photographs", { timeout: MODEL_TIMEOUT_MS }, () => {
  let engine: ObjectEngine;

  beforeAll(async () => {
    engine = await ObjectEngine.create({
      detectorPath: modelPath(OBJECT_DETECTOR_MODEL.fileName),
    });
  }, MODEL_TIMEOUT_MS);

  afterAll(async () => {
    await engine?.dispose();
  });

  it("counts four people in a four-person group photo", async () => {
    // The assertion that ties the whole path together: class table alignment, box
    // decoding, sigmoid scoring, and preprocessing all have to be right for this
    // number to come out. It is also precisely the signal §9 wants objects for —
    // counting, which §5.4 says must never route to CLIP.
    const result = await engine.detect(
      new Uint8Array(readFileSync(fixturePath("group-4.jpg"))),
    );
    const people = result.objects.filter((o) => className(o.classIndex) === "person");
    expect(people).toHaveLength(4);
    expect(people.every((p) => p.score > 0.8)).toBe(true);
  });

  it("finds one person in a portrait", async () => {
    const result = await engine.detect(
      new Uint8Array(readFileSync(fixturePath("portrait-a1.jpg"))),
    );
    expect(result.objects.filter((o) => className(o.classIndex) === "person")).toHaveLength(1);
  });

  it("scores several classes above 0.9 at once, which rules out a softmax", async () => {
    // A softmax over 80 classes forces them to sum to 1, so two classes at 0.9 is
    // arithmetically impossible under it. This is the discriminating evidence that
    // the per-class sigmoid is the right reading — and the reason §9's "softmax over
    // logits" note does not apply to this model.
    const result = await engine.detect(
      new Uint8Array(readFileSync(fixturePath("group-4.jpg"))),
    );
    const confident = result.objects.filter((o) => o.score > 0.9);
    expect(confident.length).toBeGreaterThan(1);
    expect(new Set(confident.map((o) => o.classIndex)).size).toBeGreaterThan(1);
  });

  it("reports display dimensions, not the 640² it analysed", async () => {
    const result = await engine.detect(
      new Uint8Array(readFileSync(fixturePath("group-4.jpg"))),
    );
    expect(result.width).toBe(4096);
    expect(result.height).toBe(2731);
    expect(result.width).not.toBe(OBJECT_INPUT_SIZE);
  });

  it("puts every box inside the frame", async () => {
    const result = await engine.detect(
      new Uint8Array(readFileSync(fixturePath("group-4.jpg"))),
    );
    for (const object of result.objects) {
      const [x, y, w, h] = object.bbox;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(result.width);
      expect(y + h).toBeLessThanOrEqual(result.height);
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
    }
  });

  it("finds a person box that actually covers most of a portrait", async () => {
    // A sanity check on the un-projection: the squashed 640² input means two
    // independent scale factors, and getting one wrong yields a box of the right
    // shape in the wrong place. A portrait's subject is most of the frame.
    const result = await engine.detect(
      new Uint8Array(readFileSync(fixturePath("portrait-a1.jpg"))),
    );
    const person = result.objects.find((o) => className(o.classIndex) === "person")!;
    const area = (person.bbox[2] * person.bbox[3]) / (result.width * result.height);
    expect(area).toBeGreaterThan(0.4);
  });

  it("respects a raised threshold", async () => {
    const strict = await ObjectEngine.create({
      detectorPath: modelPath(OBJECT_DETECTOR_MODEL.fileName),
      scoreThreshold: 0.95,
    });
    try {
      const loose = await engine.detect(
        new Uint8Array(readFileSync(fixturePath("group-4.jpg"))),
      );
      const tight = await strict.detect(
        new Uint8Array(readFileSync(fixturePath("group-4.jpg"))),
      );
      expect(tight.objects.length).toBeLessThan(loose.objects.length);
    } finally {
      await strict.dispose();
    }
  });
});
