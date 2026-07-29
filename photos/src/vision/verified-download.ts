/**
 * Download a file and only keep it if its SHA-256 matches.
 *
 * Its own module because it is the one part of model installation with a
 * security property worth pinning, and because it has two callers that must not
 * diverge: the `vision:fetch-*` scripts and `model-download.ts`, which serves
 * the in-app download. It lives under `src/vision/` rather than `scripts/lib/`
 * for the second of those — a route may not import from `scripts/`.
 *
 * Nothing here touches the engine or onnxruntime, so it is safe in the Next
 * server graph (see `__tests__/vision-bundle-isolation.test.ts`).
 *
 * The invariant: **a failed verification leaves nothing behind.** Model presence
 * is later judged by file size (re-hashing 278 MB on every status poll would
 * make the Settings panel unusable), so a partial or tampered file surviving on
 * disk would be picked up as installed, and the failure would resurface as an
 * opaque ONNX load error in the middle of a scan.
 */

import { createHash } from "node:crypto";
import { createWriteStream, renameSync, rmSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface VerifiedDownloadOptions {
  url: string;
  /** Final path. Written only after the digest matches. */
  target: string;
  /** Expected SHA-256, lowercase hex. */
  sha256: string;
  /** Called with bytes received so far; for progress reporting. */
  onProgress?: (bytesSoFar: number) => void;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class DigestMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    target: string,
  ) {
    super(`SHA-256 mismatch for ${target}\n    expected ${expected}\n    got      ${actual}`);
    this.name = "DigestMismatchError";
  }
}

/**
 * Streams to `${target}.download`, hashing as it lands, and `rename`s into place
 * only on a match. Returns the verified digest.
 *
 * Hashing the stream rather than re-reading the finished file means a 261 MB
 * model is read once, and means there is never a moment where the full bytes sit
 * at the final path unverified.
 */
export async function verifiedDownload(options: VerifiedDownloadOptions): Promise<string> {
  const { url, target, sha256, onProgress } = options;
  const doFetch = options.fetchImpl ?? fetch;

  const res = await doFetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }

  const tmp = `${target}.download`;
  // A leftover from an interrupted run would otherwise be appended to.
  rmSync(tmp, { force: true });

  const hash = createHash("sha256");
  let seen = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      seen += chunk.byteLength;
      onProgress?.(seen);
      done(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      tap,
      createWriteStream(tmp),
    );
    const digest = hash.digest("hex");
    if (digest !== sha256) throw new DigestMismatchError(sha256, digest, target);
    renameSync(tmp, target);
    return digest;
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
