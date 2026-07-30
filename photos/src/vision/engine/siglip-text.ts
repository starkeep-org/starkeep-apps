/**
 * The text tower: a query string → one L2-normalized vector in the same space as
 * the stored image embeddings.
 *
 * The counterpart to `siglip.ts`, and the reason search needs a worker at all
 * (plan §6): a free-form query cannot be precomputed, so this has to run per
 * request, interactively, while `onnxruntime-node` must stay unreachable from
 * `app/`.
 *
 * ⚠ **Never import this from `app/`.** Reached only from
 * `search/query-worker.ts`, which the query controller starts by absolute path.
 * `__tests__/vision-bundle-isolation.test.ts` guards the whole `engine/`
 * directory.
 *
 * Two things the graph pins that are easy to get wrong:
 *
 *   - **`input_ids` is int64.** Feeding int32 fails at `run()` rather than
 *     silently, which is the good case, but it means the tokenizer's natural
 *     `Int32Array` has to be widened here.
 *   - **There is no attention mask.** The tower takes only `input_ids`, because
 *     SigLIP pads every sequence to a fixed 64 and was trained that way. Padding
 *     is part of the input, not something to mask out.
 */

import type { InferenceSession, Tensor } from "onnxruntime-node";
import { SCENE_EMBEDDING_DIM, SEARCH_TEXT_TOKENS } from "../models";
import { GemmaTokenizer } from "../search/tokenizer";
import { l2Normalize } from "./face-engine";

export class TextEngine {
  private constructor(
    private readonly text: InferenceSession,
    private readonly ort: typeof import("onnxruntime-node"),
    private readonly tokenizer: GemmaTokenizer,
  ) {}

  static async create(options: {
    textPath: string;
    tokenizerPath: string;
  }): Promise<TextEngine> {
    const ort = await import("onnxruntime-node");
    // The tokenizer is ~34 MB of JSON and ~840 k map entries, so it is built once
    // and held for the engine's life — which is the worker's life.
    const tokenizer = GemmaTokenizer.fromFile(options.tokenizerPath);
    const text = await ort.InferenceSession.create(options.textPath);
    return new TextEngine(text, ort, tokenizer);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.text.release()]);
  }

  /**
   * Embed one query string.
   *
   * Unit-length, so cosine against an index row is a plain dot product — the same
   * contract every embedding in this codebase carries.
   */
  async embed(query: string): Promise<Float32Array> {
    const [only] = await this.embedAll([query]);
    return only;
  }

  /**
   * Embed several strings, averaging nothing — one vector out per string in.
   *
   * Batched because §5.3's prompt ensembling needs the raw residual *and*
   * `"a photo of {residual}"` per query, and because scoring a tag vocabulary
   * (§7) is hundreds of strings at once. One `run()` over a `[n, 64]` tensor
   * rather than n runs over `[1, 64]`.
   */
  async embedAll(queries: readonly string[]): Promise<Float32Array[]> {
    if (queries.length === 0) return [];

    const ids = new BigInt64Array(queries.length * SEARCH_TEXT_TOKENS);
    queries.forEach((query, row) => {
      const encoded = this.tokenizer.encode(query);
      for (let i = 0; i < SEARCH_TEXT_TOKENS; i++) {
        ids[row * SEARCH_TEXT_TOKENS + i] = BigInt(encoded[i]);
      }
    });

    const feeds: Record<string, Tensor> = {
      input_ids: new this.ort.Tensor("int64", ids, [queries.length, SEARCH_TEXT_TOKENS]),
    };
    const outputs = await this.text.run(feeds);

    // `pooler_output` is the projected sentence vector; `last_hidden_state` is
    // per-token and would read as a [64, 1152] matrix flattened into a vector.
    // Both are present, both are float32, and only one is right — so this is named
    // rather than positional.
    const pooled = outputs.pooler_output ?? outputs[this.text.outputNames[0]];
    const data = pooled.data as Float32Array;
    const expected = queries.length * SCENE_EMBEDDING_DIM;
    if (data.length !== expected) {
      throw new Error(
        `text tower returned ${data.length} floats, expected ${expected} ` +
          `(${queries.length} × ${SCENE_EMBEDDING_DIM}); outputs are ${this.text.outputNames.join(", ")}`,
      );
    }

    return queries.map((_, row) =>
      l2Normalize(data.slice(row * SCENE_EMBEDDING_DIM, (row + 1) * SCENE_EMBEDDING_DIM)),
    );
  }
}
