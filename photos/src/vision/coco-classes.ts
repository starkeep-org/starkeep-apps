/**
 * The COCO-80 class names the object detector emits, **in its label order**.
 *
 * Order is the contract: the model outputs 80 logits per query and the index into
 * this array *is* the class. Reordering it, sorting it, or "fixing" a name
 * relabels every stored detection without changing a byte of the model — which is
 * why `vision-objects.test.ts` pins the array against the exported
 * `config.json`'s `id2label` rather than trusting it to stay right.
 *
 * Taken verbatim from `onnx-community/rtdetr_v2_r101vd-ONNX`, including its
 * spellings: `motorbike` and `aeroplane` rather than the `motorcycle` and
 * `airplane` most COCO tables use, and `tvmonitor` / `pottedplant` /
 * `diningtable` unspaced. Those are what the checkpoint was trained with, so they
 * are what the indices mean. Search resolves user-facing synonyms separately
 * (`CLASS_SYNONYMS`) rather than by editing this list.
 *
 * No ONNX here: search and the overlay both need these names, and both live on
 * the `app/` side.
 */

export const COCO_CLASSES: readonly string[] = [
  "person", "bicycle", "car", "motorbike", "aeroplane", "bus",
  "train", "truck", "boat", "traffic light", "fire hydrant", "stop sign",
  "parking meter", "bench", "bird", "cat", "dog", "horse",
  "sheep", "cow", "elephant", "bear", "zebra", "giraffe",
  "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
  "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
  "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza",
  "donut", "cake", "chair", "sofa", "pottedplant", "bed",
  "diningtable", "toilet", "tvmonitor", "laptop", "mouse", "remote",
  "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
  "hair drier", "toothbrush",
];

/**
 * What a person is likely to type, mapped to the class the model actually knows.
 *
 * Separate from `COCO_CLASSES` because that array's order is a model contract and
 * this is a UX concern — a synonym table can grow freely, and someone searching
 * for "airplane" should not have to know the checkpoint spells it "aeroplane".
 *
 * Deliberately not a stemmer or a fuzzy matcher: the vocabulary is 80 items and
 * closed, so an explicit table is inspectable and cannot surprise anyone by
 * matching "carpet" to "carrot". Plurals are handled by the parse, not here.
 */
export const CLASS_SYNONYMS: Readonly<Record<string, string>> = {
  airplane: "aeroplane",
  plane: "aeroplane",
  motorcycle: "motorbike",
  motorbike: "motorbike",
  tv: "tvmonitor",
  television: "tvmonitor",
  monitor: "tvmonitor",
  screen: "tvmonitor",
  "potted plant": "pottedplant",
  plant: "pottedplant",
  "dining table": "diningtable",
  table: "diningtable",
  couch: "sofa",
  settee: "sofa",
  mobile: "cell phone",
  phone: "cell phone",
  cellphone: "cell phone",
  "mobile phone": "cell phone",
  fridge: "refrigerator",
  "hair dryer": "hair drier",
  hairdryer: "hair drier",
  bike: "bicycle",
  cycle: "bicycle",
  people: "person",
  man: "person",
  woman: "person",
  child: "person",
  kid: "person",
  ball: "sports ball",
  glass: "wine glass",
  racket: "tennis racket",
  racquet: "tennis racket",
  computer: "laptop",
};

/** `person` → 0. Built once; the array is the source of truth. */
const BY_NAME = new Map(COCO_CLASSES.map((name, index) => [name, index]));

export function classIndex(name: string): number | null {
  const index = BY_NAME.get(name);
  return index === undefined ? null : index;
}

export function className(index: number): string | null {
  return COCO_CLASSES[index] ?? null;
}

/**
 * Resolve a user-typed word to a class name, via synonyms and naive plurals.
 *
 * Plurals matter more than they look: `"photos with three dogs"` is the whole
 * point of having counts (§5.4), and it never contains the singular. Stripping a
 * trailing `s` — and `es` for `glasses`/`buses` — covers the closed vocabulary
 * without a stemmer that could mangle `skis`, which is already plural and *is* the
 * class name, so the exact match is tried first.
 */
export function resolveClass(word: string): string | null {
  const key = word.toLowerCase().trim();
  if (key.length === 0) return null;
  if (BY_NAME.has(key)) return key;
  const synonym = CLASS_SYNONYMS[key];
  if (synonym) return synonym;
  for (const singular of depluralize(key)) {
    if (BY_NAME.has(singular)) return singular;
    const viaSynonym = CLASS_SYNONYMS[singular];
    if (viaSynonym) return viaSynonym;
  }
  return null;
}

function depluralize(word: string): string[] {
  const out: string[] = [];
  if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.endsWith("s")) out.push(word.slice(0, -1));
  return out;
}
