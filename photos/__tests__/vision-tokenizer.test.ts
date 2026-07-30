import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GemmaTokenizer } from "@/vision/search/tokenizer";
import {
  SEARCH_EOS_ID,
  SEARCH_PAD_ID,
  SEARCH_TEXT_TOKENS,
  SEARCH_TOKENIZER,
} from "@/vision/models";
import { modelPath } from "@/vision/paths";

/**
 * The tokenizer, against HuggingFace's own output.
 *
 * This is the test that makes a hand-written tokenizer defensible. A subtly wrong
 * encoding does not throw and does not change a shape — it produces a slightly
 * different token sequence, therefore a slightly different query embedding,
 * therefore quietly worse search, with nothing to point at months later. Only
 * comparison against the reference implementation rules that out.
 *
 * `fixtures/gemma-tokenizer-vectors.json` was generated with the real
 * `tokenizers` library over the pinned `tokenizer.json`:
 *
 *     Tokenizer.from_file("tokenizer.json").encode(text).ids
 *
 * Committed rather than regenerated, because the point is to detect *our* drift.
 * If the pinned tokenizer file ever changes, these vectors must be regenerated
 * deliberately — a silent regeneration would defeat the test.
 *
 * The cases deliberately include the things that break naive implementations:
 * mixed case (which must **not** be folded), leading and repeated spaces, tabs,
 * an apostrophe, non-Latin scripts, combining accents, an emoji, and a
 * 200-character string that overruns the fixed 64-token window.
 *
 * **Skipped unless the tokenizer is installed** (`pnpm vision:fetch-models
 * --search`), like the other model-dependent tests.
 */

interface ReferenceCase {
  text: string;
  /** Ids before `<eos>` — the raw BPE output. */
  tokens: number[];
  /** The full 64-long padded tensor the tower receives. */
  padded: number[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REFERENCE = JSON.parse(
  readFileSync(join(HERE, "fixtures", "gemma-tokenizer-vectors.json"), "utf-8"),
) as ReferenceCase[];

const tokenizerPath = modelPath(SEARCH_TOKENIZER.fileName);
const installed = (() => {
  try {
    return readFileSync(tokenizerPath).byteLength === SEARCH_TOKENIZER.sizeBytes;
  } catch {
    return false;
  }
})();

describe.skipIf(!installed)("GemmaTokenizer against the reference implementation", () => {
  const tokenizer = installed ? GemmaTokenizer.fromFile(tokenizerPath) : null;

  it("loads the vocabulary the model config declares", () => {
    expect(tokenizer!.vocabSize).toBe(256_000);
  });

  it.each(REFERENCE.map((c) => [c.text, c] as const))(
    "encodes %j exactly as HuggingFace does",
    (_text, expected) => {
      expect(tokenizer!.encodeTokens(expected.text)).toEqual(expected.tokens);
    },
  );

  it.each(REFERENCE.map((c) => [c.text, c] as const))(
    "pads %j to the fixed window exactly as HuggingFace does",
    (_text, expected) => {
      expect([...tokenizer!.encode(expected.text)]).toEqual(expected.padded);
    },
  );

  it("does not fold case", () => {
    // `do_lower_case: true` in tokenizer_config.json is a legacy field the fast
    // tokenizer ignores. Lowercasing here would diverge from the reference on
    // every capitalized query — including every person's name.
    const mixed = tokenizer!.encodeTokens("Alice at the beach");
    const upper = tokenizer!.encodeTokens("ALICE AT THE BEACH");
    const lower = tokenizer!.encodeTokens("alice at the beach");
    expect(mixed).not.toEqual(upper);
    expect(mixed).not.toEqual(lower);
  });

  it("gives the first word no leading word-boundary marker", () => {
    // The normalizer replaces spaces with `▁`; it does not *add* one. So the
    // leading token is bare `at`, and subsequent ones carry the marker. Adding a
    // prefix space would shift every single token id.
    expect(tokenizer!.encodeTokens("at the beach")).toEqual([482, 573, 8318]);
    expect(tokenizer!.encodeTokens("the")).not.toEqual(tokenizer!.encodeTokens(" the"));
  });

  it("prefers the longest merge, so 'hot dog' is not 'hot' + 'dog'", () => {
    // The §5 parse relies on longest-match at the *vocabulary* level; this is the
    // analogous property one level down, and a merge-ranking bug shows up here.
    const hotDog = tokenizer!.encodeTokens("hot dog");
    const dog = tokenizer!.encodeTokens("dog");
    expect(hotDog).not.toEqual([...tokenizer!.encodeTokens("hot"), ...dog]);
  });

  it("always returns exactly the fixed window, terminated", () => {
    for (const { text } of REFERENCE) {
      const ids = tokenizer!.encode(text);
      expect(ids.length).toBe(SEARCH_TEXT_TOKENS);
      expect(ids).toContain(SEARCH_EOS_ID);
    }
  });

  it("truncates an overlong query but keeps its terminator", () => {
    // The one place we deliberately diverge from the reference tokenizer, which
    // has `truncation: null` and happily returns 111 ids for this input. It is the
    // *processor* that truncates upstream of the model, and it has to: the text
    // tower has 64 position embeddings, so a longer tensor is not a slower
    // inference, it is an invalid one.
    //
    // Truncation gives up a token rather than the terminator, because a sequence
    // with no `<eos>` is a different input distribution than the tower saw in
    // training.
    const overlong = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(tokenizer!.encodeTokens(overlong).length).toBeGreaterThan(SEARCH_TEXT_TOKENS);

    const ids = tokenizer!.encode(overlong);
    expect(ids.length).toBe(SEARCH_TEXT_TOKENS);
    expect(ids[SEARCH_TEXT_TOKENS - 1]).toBe(SEARCH_EOS_ID);
    expect(ids).not.toContain(SEARCH_PAD_ID);
  });

  it("pads rather than truncates when BPE collapses a long string", () => {
    // 500 identical characters merge into long runs, so this is *not* an overlong
    // sequence despite its length — a reminder that the window is measured in
    // tokens, not characters.
    const ids = tokenizer!.encode("x".repeat(500));
    expect(ids.length).toBe(SEARCH_TEXT_TOKENS);
    expect(ids).toContain(SEARCH_PAD_ID);
    expect(ids).toContain(SEARCH_EOS_ID);
  });

  it("encodes an empty query as nothing but a terminator", () => {
    const ids = tokenizer!.encode("");
    expect(ids[0]).toBe(SEARCH_EOS_ID);
    expect(ids.slice(1).every((id) => id === SEARCH_PAD_ID)).toBe(true);
  });

  it("is deterministic", () => {
    const once = tokenizer!.encode("a photo of at the beach");
    const twice = tokenizer!.encode("a photo of at the beach");
    expect([...once]).toEqual([...twice]);
  });
});
