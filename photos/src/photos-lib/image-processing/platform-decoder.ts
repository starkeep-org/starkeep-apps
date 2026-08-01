/**
 * Decoding formats sharp cannot, using the host platform's own decoder
 * (item 32).
 *
 * ## What is actually broken
 *
 * sharp reports `sharp.format.heif.input === true`, and
 * `sharp(heic).metadata()` succeeds and returns real dimensions. Then the
 * decode fails:
 *
 *     heif: Error while loading plugin: Support for this compression format
 *     has not been built in
 *
 * That is libvips reporting what it was *compiled* with, not what it can do:
 * the prebuilt sharp ships libheif with AVIF but no HEVC decoder, because HEVC
 * carries patent licensing that a redistributed binary cannot assume. So HEIC
 * looks supported at the probe layer and fails at the decode layer — and
 * anything that gates on "can I read the metadata" concludes it is fine.
 *
 * ## Why the macOS decoder and not a libvips build
 *
 * Building libvips with libheif + libde265 is rejected in the plan (§12), and
 * this is the alternative it names. macOS ships a licensed HEVC decoder that
 * `sips` drives, so a laptop can derive from HEIC with no new dependency and no
 * licensing question. That is exactly the machine the backfill runs on.
 *
 * **The asymmetry is deliberate and load-bearing.** A Linux container still
 * cannot decode HEIC, and that is an accepted consequence: such a record stays
 * ladder-incomplete, which means it is *never archived* and never evicted. The
 * safe direction — the cost is storage, not a photo nobody can open.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { UndecodableError } from "./decode-errors";

const run = promisify(execFile);

/**
 * Formats sharp's prebuilt binary cannot decode, whatever it claims.
 *
 * HEIC/HEIF only. AVIF is also HEIF-shaped but uses AV1, which the bundled
 * libheif *does* have — so routing it here would send work to a slower path for
 * no reason.
 */
export const NEEDS_PLATFORM_DECODER: readonly string[] = [
  "image/heic",
  "image/heif",
];

export function needsPlatformDecoder(type: string): boolean {
  return NEEDS_PLATFORM_DECODER.includes(type);
}

/**
 * Converts bytes sharp cannot read into bytes it can.
 *
 * Deliberately a *transcode to JPEG*, not a full replacement for the ladder.
 * Everything downstream — resizing, AVIF encoding, ThumbHash, the perceptual
 * hash — already works and is well tested against JPEG input; re-implementing
 * any of it against a second decoder would be two code paths that drift. This
 * only has to get the pixels into a form the existing pipeline accepts.
 */
export interface PlatformDecoder {
  /** Whether this decoder can run here at all. Cheap; cached. */
  available(): Promise<boolean>;
  /** Decode to JPEG bytes sharp can then process normally. */
  toJpeg(bytes: Uint8Array, sourceType: string): Promise<Uint8Array>;
}

export interface SipsDecoderOptions {
  readonly sipsPath?: string;
  readonly timeoutMs?: number;
  /**
   * Quality floor for the intermediate JPEG.
   *
   * High on purpose. This is an intermediate that gets resized and re-encoded
   * to AVIF afterwards, so its artefacts compound into every rung of the
   * ladder — the one place in the pipeline where being stingy costs quality
   * permanently, in files that outlive the original once it is archived.
   */
  readonly quality?: "low" | "normal" | "high" | "best";
}

/**
 * macOS `sips`, which drives ImageIO — the same decoder Preview and Finder use.
 *
 * `sips` rather than a native binding: it is present on every macOS install
 * with no build step, no native module to compile per Node version, and no
 * dependency to keep current. The cost is a subprocess and a temp file per
 * image, which is real but small next to decoding and re-encoding a 12 MP
 * photo four times.
 */
export function createSipsDecoder(options: SipsDecoderOptions = {}): PlatformDecoder {
  const sips = options.sipsPath ?? "sips";
  const timeout = options.timeoutMs ?? 120_000;
  const quality = options.quality ?? "best";

  let availability: Promise<boolean> | null = null;

  return {
    async available(): Promise<boolean> {
      availability ??= (async () => {
        // Checked by running it, not by reading process.platform. A darwin
        // check would be a claim about the OS; this is a claim about the
        // binary, which is the thing actually being depended on.
        if (process.platform !== "darwin") return false;
        try {
          await run(sips, ["--help"], { timeout: 10_000 });
          return true;
        } catch {
          return false;
        }
      })();
      return availability;
    },

    async toJpeg(bytes: Uint8Array, sourceType: string): Promise<Uint8Array> {
      if (!(await this.available())) {
        throw new UndecodableError(
          `no platform decoder for ${sourceType} on this node`,
          sourceType,
        );
      }
      const dir = await mkdtemp(join(tmpdir(), "photos-decode-"));
      // The extension matters: sips dispatches on it, and a HEIC written as
      // `.bin` is refused before ImageIO ever sees it.
      const input = join(dir, `in${extensionFor(sourceType)}`);
      const output = join(dir, "out.jpg");
      try {
        await writeFile(input, bytes);
        await run(
          sips,
          ["-s", "format", "jpeg", "-s", "formatOptions", quality, input, "--out", output],
          { timeout },
        );
        return new Uint8Array(await readFile(output));
      } catch (err) {
        // A failure here is genuinely terminal: the platform decoder is the
        // last resort, so there is nothing further to try on this node.
        throw new UndecodableError(
          `platform decoder could not read ${sourceType}: ${(err as Error).message}`,
          sourceType,
          { cause: err },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function extensionFor(type: string): string {
  if (type === "image/heic") return ".heic";
  if (type === "image/heif") return ".heif";
  const slash = type.indexOf("/");
  return slash >= 0 ? `.${type.slice(slash + 1)}` : ".img";
}

/** A decoder that is never available — for tests and non-macOS defaults. */
export const NO_PLATFORM_DECODER: PlatformDecoder = {
  available: async () => false,
  async toJpeg(_bytes: Uint8Array, sourceType: string): Promise<Uint8Array> {
    throw new UndecodableError(`no platform decoder for ${sourceType}`, sourceType);
  },
};
