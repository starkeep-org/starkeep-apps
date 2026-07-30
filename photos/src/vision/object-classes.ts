/**
 * The Objects365 class names the object detector emits, **in its label order**.
 *
 * Order is the contract: the model outputs 366 logits per query and the index into
 * this array *is* the class. Reordering it, sorting it, or "fixing" a name relabels
 * every stored detection without changing a byte of the model — which is why
 * `vision-objects.test.ts` pins the array against the exported `config.json`'s
 * `id2label` rather than trusting it to stay right.
 *
 * Taken verbatim from `onnx-community/dfine_x_obj365-ONNX`, **including its
 * mistakes**: `Dinning Table` is misspelt upstream, `Skiboard` is one word, and
 * several entries are Title Case with embedded slashes (`Monitor/TV`,
 * `Picture/Frame`). Those strings are what the indices mean, so they stay exactly as
 * exported. Everything a user might actually type is resolved separately — see
 * `ALIASES` and `CLASS_SYNONYMS` below — rather than by editing this list.
 *
 * **Index 0 is `None`.** Objects365 is 1-indexed upstream and the conversion left a
 * placeholder in slot 0. The graph really does emit 366 logits, so the slot has to
 * exist here to keep every other index aligned; it is never a detection, and
 * `BACKGROUND_CLASS` is what the decoder and `className` use to keep it from
 * surfacing. Measured on the test fixtures, it never wins a query at any usable
 * threshold — this is belt-and-braces against a label reading "None" in the UI.
 *
 * No ONNX here: search and the overlay both need these names, and both live on
 * the `app/` side.
 */

export const OBJECT_CLASSES: readonly string[] = [
  "None", "Person", "Sneakers", "Chair", "Other Shoes", "Hat",
  "Car", "Lamp", "Glasses", "Bottle", "Desk", "Cup",
  "Street Lights", "Cabinet/shelf", "Handbag/Satchel", "Bracelet", "Plate", "Picture/Frame",
  "Helmet", "Book", "Gloves", "Storage box", "Boat", "Leather Shoes",
  "Flower", "Bench", "Potted Plant", "Bowl/Basin", "Flag", "Pillow",
  "Boots", "Vase", "Microphone", "Necklace", "Ring", "SUV",
  "Wine Glass", "Belt", "Monitor/TV", "Backpack", "Umbrella", "Traffic Light",
  "Speaker", "Watch", "Tie", "Trash bin Can", "Slippers", "Bicycle",
  "Stool", "Barrel/bucket", "Van", "Couch", "Sandals", "Basket",
  "Drum", "Pen/Pencil", "Bus", "Wild Bird", "High Heels", "Motorcycle",
  "Guitar", "Carpet", "Cell Phone", "Bread", "Camera", "Canned",
  "Truck", "Traffic cone", "Cymbal", "Lifesaver", "Towel", "Stuffed Toy",
  "Candle", "Sailboat", "Laptop", "Awning", "Bed", "Faucet",
  "Tent", "Horse", "Mirror", "Power outlet", "Sink", "Apple",
  "Air Conditioner", "Knife", "Hockey Stick", "Paddle", "Pickup Truck", "Fork",
  "Traffic Sign", "Balloon", "Tripod", "Dog", "Spoon", "Clock",
  "Pot", "Cow", "Cake", "Dinning Table", "Sheep", "Hanger",
  "Blackboard/Whiteboard", "Napkin", "Other Fish", "Orange/Tangerine", "Toiletry", "Keyboard",
  "Tomato", "Lantern", "Machinery Vehicle", "Fan", "Green Vegetables", "Banana",
  "Baseball Glove", "Airplane", "Mouse", "Train", "Pumpkin", "Soccer",
  "Skiboard", "Luggage", "Nightstand", "Tea pot", "Telephone", "Trolley",
  "Head Phone", "Sports Car", "Stop Sign", "Dessert", "Scooter", "Stroller",
  "Crane", "Remote", "Refrigerator", "Oven", "Lemon", "Duck",
  "Baseball Bat", "Surveillance Camera", "Cat", "Jug", "Broccoli", "Piano",
  "Pizza", "Elephant", "Skateboard", "Surfboard", "Gun", "Skating and Skiing shoes",
  "Gas stove", "Donut", "Bow Tie", "Carrot", "Toilet", "Kite",
  "Strawberry", "Other Balls", "Shovel", "Pepper", "Computer Box", "Toilet Paper",
  "Cleaning Products", "Chopsticks", "Microwave", "Pigeon", "Baseball", "Cutting/chopping Board",
  "Coffee Table", "Side Table", "Scissors", "Marker", "Pie", "Ladder",
  "Snowboard", "Cookies", "Radiator", "Fire Hydrant", "Basketball", "Zebra",
  "Grape", "Giraffe", "Potato", "Sausage", "Tricycle", "Violin",
  "Egg", "Fire Extinguisher", "Candy", "Fire Truck", "Billiards", "Converter",
  "Bathtub", "Wheelchair", "Golf Club", "Briefcase", "Cucumber", "Cigar/Cigarette",
  "Paint Brush", "Pear", "Heavy Truck", "Hamburger", "Extractor", "Extension Cord",
  "Tong", "Tennis Racket", "Folder", "American Football", "earphone", "Mask",
  "Kettle", "Tennis", "Ship", "Swing", "Coffee Machine", "Slide",
  "Carriage", "Onion", "Green beans", "Projector", "Frisbee", "Washing Machine/Drying Machine",
  "Chicken", "Printer", "Watermelon", "Saxophone", "Tissue", "Toothbrush",
  "Ice cream", "Hot-air balloon", "Cello", "French Fries", "Scale", "Trophy",
  "Cabbage", "Hot dog", "Blender", "Peach", "Rice", "Wallet/Purse",
  "Volleyball", "Deer", "Goose", "Tape", "Tablet", "Cosmetics",
  "Trumpet", "Pineapple", "Golf Ball", "Ambulance", "Parking meter", "Mango",
  "Key", "Hurdle", "Fishing Rod", "Medal", "Flute", "Brush",
  "Penguin", "Megaphone", "Corn", "Lettuce", "Garlic", "Swan",
  "Helicopter", "Green Onion", "Sandwich", "Nuts", "Speed Limit Sign", "Induction Cooker",
  "Broom", "Trombone", "Plum", "Rickshaw", "Goldfish", "Kiwi fruit",
  "Router/modem", "Poker Card", "Toaster", "Shrimp", "Sushi", "Cheese",
  "Notepaper", "Cherry", "Pliers", "CD", "Pasta", "Hammer",
  "Cue", "Avocado", "Hamimelon", "Flask", "Mushroom", "Screwdriver",
  "Soap", "Recorder", "Bear", "Eggplant", "Board Eraser", "Coconut",
  "Tape Measure/Ruler", "Pig", "Showerhead", "Globe", "Chips", "Steak",
  "Crosswalk Sign", "Stapler", "Camel", "Formula 1", "Pomegranate", "Dishwasher",
  "Crab", "Hoverboard", "Meat ball", "Rice Cooker", "Tuba", "Calculator",
  "Papaya", "Antelope", "Parrot", "Seal", "Butterfly", "Dumbbell",
  "Donkey", "Lion", "Urinal", "Dolphin", "Electric Drill", "Hair Dryer",
  "Egg tart", "Jellyfish", "Treadmill", "Lighter", "Grapefruit", "Game board",
  "Mop", "Radish", "Baozi", "Target", "French", "Spring Rolls",
  "Monkey", "Rabbit", "Pencil Case", "Yak", "Red Cabbage", "Binoculars",
  "Asparagus", "Barbell", "Scallop", "Noddles", "Comb", "Dumpling",
  "Oyster", "Table Tennis paddle", "Cosmetics Brush/Eyeliner Pencil", "Chainsaw", "Eraser", "Lobster",
  "Durian", "Okra", "Lipstick", "Cosmetics Mirror", "Curling", "Table Tennis",];

/**
 * Slot 0's placeholder — not a thing that can be in a photo.
 *
 * Exported so the decoder and the name lookup agree about it. A magic `0` in two
 * files is how the two quietly stop agreeing.
 */
export const BACKGROUND_CLASS = 0;

/**
 * What a person is likely to type, mapped to the class the model actually knows.
 *
 * Separate from `OBJECT_CLASSES` because that array's order is a model contract and
 * this is a UX concern. At 80 closed classes the old table could be exhaustive; at
 * 365 it cannot be, so this is explicitly a *starting point* covering the cases most
 * likely to be typed at a photo library, not a complete synonym set. It is also the
 * layer that hides the upstream typo: nobody should have to type `dinning`.
 *
 * Keys are matched case-insensitively; values must be verbatim `OBJECT_CLASSES`
 * entries, which `vision-objects.test.ts` checks.
 */
export const CLASS_SYNONYMS: Readonly<Record<string, string>> = {
  // People
  people: "Person",
  man: "Person",
  woman: "Person",
  child: "Person",
  kid: "Person",
  boy: "Person",
  girl: "Person",
  baby: "Person",
  // Furniture — including the upstream misspelling of "dining"
  sofa: "Couch",
  settee: "Couch",
  "dining table": "Dinning Table",
  table: "Dinning Table",
  plant: "Potted Plant",
  bookshelf: "Cabinet/shelf",
  shelves: "Cabinet/shelf",
  // Screens and devices
  tv: "Monitor/TV",
  television: "Monitor/TV",
  screen: "Monitor/TV",
  computer: "Laptop",
  phone: "Cell Phone",
  mobile: "Cell Phone",
  cellphone: "Cell Phone",
  "mobile phone": "Cell Phone",
  headphones: "Head Phone",
  earphones: "earphone",
  fridge: "Refrigerator",
  "hair drier": "Hair Dryer",
  hairdryer: "Hair Dryer",
  // Vehicles
  plane: "Airplane",
  aeroplane: "Airplane",
  motorbike: "Motorcycle",
  bike: "Bicycle",
  cycle: "Bicycle",
  // Animals — Objects365 qualifies the generic ones
  bird: "Wild Bird",
  birds: "Wild Bird",
  fish: "Other Fish",
  // Things worn
  sunglasses: "Glasses",
  spectacles: "Glasses",
  shoes: "Other Shoes",
  trainers: "Sneakers",
  // Toys and sport
  "teddy bear": "Stuffed Toy",
  teddy: "Stuffed Toy",
  skis: "Skiboard",
  ball: "Other Balls",
  "soccer ball": "Soccer",
  football: "Soccer",
  racquet: "Tennis Racket",
  racket: "Tennis Racket",
  // Pictures. Note "photo"/"picture" are deliberately absent — in a photo app they
  // mean the medium, not a framed picture on a wall. `parse.ts` guards this too.
  painting: "Picture/Frame",
};

/**
 * Lowercased name → index, plus an alias for each side of a slashed class.
 *
 * `Monitor/TV` is one category but two words people type, and neither half is
 * reachable by the exact match or by plural stripping. Splitting them here is what
 * makes `tv` and `monitor` both work without hand-listing every pair.
 *
 * The one subtlety is a slash inside a phrase, where the two alternatives share a
 * head noun that is written once at the end: `Cutting/chopping Board` must yield
 * `cutting board` and `chopping board`, not the meaningless `cutting`. So the shared
 * suffix is taken from the **last** part only, and handed to earlier parts that are
 * bare words.
 *
 * Taking it from the *first* multi-word part instead would be wrong in the mirror
 * case: `Tape Measure/Ruler` would produce `ruler measure`. The last part is the one
 * carrying the head noun whenever there is one to share, which is why the rule is
 * directional.
 */
function aliasesFor(name: string): string[] {
  if (!name.includes("/")) return [];
  const parts = name.split("/").map((part) => part.trim());
  const last = parts[parts.length - 1];
  const suffix = last.includes(" ") ? last.slice(last.indexOf(" ") + 1) : "";
  return parts.map((part) =>
    (part.includes(" ") || suffix === "" ? part : `${part} ${suffix}`).toLowerCase(),
  );
}

const BY_NAME = new Map<string, number>();
for (const [index, name] of OBJECT_CLASSES.entries()) {
  if (index === BACKGROUND_CLASS) continue;
  BY_NAME.set(name.toLowerCase(), index);
  // Aliases never overwrite a real class name: `Tennis` and `Table Tennis` both
  // exist, and an alias silently shadowing an exact category is the failure mode
  // this whole module is arranged to avoid.
  for (const alias of aliasesFor(name)) {
    if (!BY_NAME.has(alias)) BY_NAME.set(alias, index);
  }
}

/** Verbatim class name → index. Case-insensitive; `null` for anything unknown. */
export function classIndex(name: string): number | null {
  const index = BY_NAME.get(name.toLowerCase().trim());
  return index === undefined ? null : index;
}

/** Index → verbatim class name. `null` for slot 0 and for anything out of range. */
export function className(index: number): string | null {
  if (index === BACKGROUND_CLASS) return null;
  return OBJECT_CLASSES[index] ?? null;
}

/**
 * Resolve a user-typed word to a class name, via aliases, synonyms and naive plurals.
 *
 * Returns the **verbatim** class name, because that is what `className` gives the
 * rest of the system and the two are compared to each other in `search.ts`.
 *
 * Plurals matter more than they look: `"photos with three dogs"` is the whole point
 * of having counts, and it never contains the singular. Stripping a trailing `s` —
 * and `es` for `glasses`/`buses` — covers the vocabulary without a stemmer that could
 * mangle `Glasses` or `Chips`, which are already plural and *are* class names, so the
 * exact match is tried first.
 */
export function resolveClass(word: string): string | null {
  const key = word.toLowerCase().trim();
  if (key.length === 0) return null;

  const direct = BY_NAME.get(key);
  if (direct !== undefined) return OBJECT_CLASSES[direct];

  const synonym = SYNONYMS_LOWER.get(key);
  if (synonym) return synonym;

  for (const singular of depluralize(key)) {
    const viaName = BY_NAME.get(singular);
    if (viaName !== undefined) return OBJECT_CLASSES[viaName];
    const viaSynonym = SYNONYMS_LOWER.get(singular);
    if (viaSynonym) return viaSynonym;
  }
  return null;
}

const SYNONYMS_LOWER = new Map(
  Object.entries(CLASS_SYNONYMS).map(([typed, canonical]) => [typed.toLowerCase(), canonical]),
);

function depluralize(word: string): string[] {
  const out: string[] = [];
  if (word.endsWith("ies")) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.endsWith("s")) out.push(word.slice(0, -1));
  return out;
}
