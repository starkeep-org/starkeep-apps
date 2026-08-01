/**
 * Telling "this build cannot read that" apart from "that did not work just now".
 *
 * ## Why this replaced a regex over the message
 *
 * The import ledger's whole value is that `unsupported` is terminal and
 * `failed` is retried. That distinction used to be made by matching the error
 * text against `/unsupported|undecodable/i` — and the message libvips actually
 * produces for an iPhone photo is:
 *
 *     heif: Error while loading plugin: Support for this compression format
 *     has not been built in
 *
 * which contains neither word. So the single most common capture format in the
 * world was classified as a transient failure and **retried on every run,
 * forever** — exactly the behaviour the ledger exists to prevent. Worse, the
 * test covering the terminal path used a fixture string that *did* match, so
 * the suite stayed green while the real thing looped.
 *
 * The lesson generalises past this one string: an error message is the
 * *presentation* of a failure, not its classification. It gets reworded by
 * upstream libraries between minor versions, and every rewording silently flips
 * a terminal outcome into an infinite retry. So the decision is made at the
 * point of failure, where the cause is known, and carried in the type.
 */

/**
 * This build cannot decode these bytes, and trying again will not change that.
 *
 * Terminal on the node that raised it — deliberately not "terminal
 * everywhere". A laptop with the macOS decoder reads HEIC that a Linux
 * container cannot, so this is a statement about *here*, which is why the
 * import ledger that records it is node-local.
 */
export class UndecodableError extends Error {
  constructor(
    message: string,
    /** What could not be read, for the report. */
    readonly formatHint: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UndecodableError";
  }
}

/**
 * Messages that mean "no decoder for this compression", from libvips.
 *
 * Kept narrow and matched only at the decode site, where a throw is already
 * known to be a decode failure. The list is a *recogniser for a known cause*,
 * not a classifier applied to arbitrary errors — which is the distinction that
 * makes it safe to be wrong: an unrecognised decode failure stays retryable,
 * so a reworded message costs one wasted retry per sweep rather than a file
 * abandoned forever.
 */
const NO_DECODER_PATTERNS: readonly RegExp[] = [
  // What libvips says for HEVC-in-HEIF when libheif was built without it.
  /support for this compression format has not been built in/i,
  /error while loading plugin/i,
  /unsupported image format/i,
  /^unsupported/i,
  /bad extension|unknown file format|not a known file format/i,
];

/** Whether a decode failure means "never here", rather than "not now". */
export function isNoDecoderError(err: unknown): boolean {
  if (err instanceof UndecodableError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return NO_DECODER_PATTERNS.some((p) => p.test(message));
}

/**
 * Wrap a decode failure with its classification decided here.
 *
 * Anything unrecognised is re-thrown untouched and stays retryable. Guessing
 * "terminal" for an unfamiliar message is the dangerous direction: it abandons
 * files that a retry would have imported, silently and permanently, and nobody
 * notices until they go looking for a photo that never arrived.
 */
export function classifyDecodeError(err: unknown, formatHint: string | null = null): never {
  if (err instanceof UndecodableError) throw err;
  if (isNoDecoderError(err)) {
    throw new UndecodableError(
      `no decoder for ${formatHint ?? "this format"} on this node: ${
        err instanceof Error ? err.message : String(err)
      }`,
      formatHint,
      { cause: err },
    );
  }
  throw err;
}
