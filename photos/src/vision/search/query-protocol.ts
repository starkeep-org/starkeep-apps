/**
 * The messages the Next server and the query worker exchange.
 *
 * Its own module, with no ONNX and no `worker_threads` import, because both sides
 * need these types and only one of them may be reachable from `app/` — the same
 * split `worker-protocol.ts` makes for the scan worker.
 *
 * Requests carry an `id` because this worker is **long-lived and concurrent**,
 * unlike the scan worker: two searches can be in flight, and replies are not
 * guaranteed to arrive in order. The scan protocol needs none of this because it
 * has exactly one conversation.
 */

export interface EmbedRequest {
  type: "embed";
  id: number;
  /** One vector out per string in. Ensembling and tag scoring both batch. */
  queries: string[];
}

/** Drop the cached index so the next search reloads it — sent after a scan. */
export interface InvalidateRequest {
  type: "invalidate";
  id: number;
}

export type QueryRequest = EmbedRequest | InvalidateRequest;

/**
 * A request before the controller assigns its correlation id.
 *
 * Distributive on purpose: a plain `Omit<QueryRequest, "id">` collapses the union
 * to the keys its members share, which is just `type` — so `queries` would stop
 * being assignable and the compiler would accept an embed request carrying no
 * queries at all.
 */
export type UnidentifiedRequest<T = QueryRequest> = T extends { id: number }
  ? Omit<T, "id">
  : never;

export interface EmbedReply {
  type: "embedded";
  id: number;
  /** Base64 little-endian float32, one per query — same encoding as sidecars. */
  vectors: string[];
}

export interface InvalidatedReply {
  type: "invalidated";
  id: number;
}

export interface ErrorReply {
  type: "error";
  id: number;
  message: string;
}

export type QueryReply = EmbedReply | InvalidatedReply | ErrorReply;

/**
 * How long the worker may sit idle before it exits.
 *
 * §6 flags this as an open question, and the tension is real in both directions:
 * the text tower is hundreds of megabytes resident, and reloading it costs a
 * second or two on the next search. Five minutes is the compromise — long enough
 * that a search session never pays the reload, short enough that a tab left open
 * overnight does not hold the memory.
 *
 * The worker measures this itself rather than the host, because only it knows when
 * it last did work.
 */
export const QUERY_WORKER_IDLE_MS = 5 * 60 * 1000;
