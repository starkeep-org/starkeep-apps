package app.starkeep.mediahash

/**
 * The arithmetic of a video poster, split from the module so a JVM test can
 * run it without a `Context` or a decoder.
 *
 * Each rule mirrors the desktop's ffmpeg poster (`video-tools.ts` in Photos):
 * never upscale, keep the aspect, and keep both sides even. A poster sized by a
 * different rule would be a second answer to "what does this rung look like".
 */
object VideoFrames {
  /** Width and height for a poster of at most `maxLongEdge`, from a source of `width`×`height`. */
  fun targetSize(width: Int, height: Int, maxLongEdge: Int): Pair<Int, Int> {
    require(width > 0 && height > 0 && maxLongEdge > 0) { "sizes must be positive" }
    val sourceLong = maxOf(width, height)
    val long = even(minOf(maxLongEdge, sourceLong))
    val short = even(Math.round(minOf(width, height).toDouble() * long / sourceLong).toInt())
    return if (width >= height) long to short else short to long
  }

  private fun even(n: Int): Int = maxOf(2, n - n % 2)

  /**
   * Whether a decoded frame still needs turning upright.
   *
   * `MediaMetadataRetriever` applies the container's rotation on some Android
   * versions and not others, so the frame's own shape decides: a frame that
   * still has the stored (unrotated) shape of a 90° or 270° clip gets rotated,
   * and one that already has the display shape does not.
   */
  fun needsRotation(frameWidth: Int, frameHeight: Int, storedWidth: Int, storedHeight: Int, rotation: Int): Boolean {
    if (rotation % 180 == 0 || storedWidth == storedHeight) return false
    return frameWidth == storedWidth && frameHeight == storedHeight
  }

  /**
   * `METADATA_KEY_DATE` as an ISO-8601 UTC instant, or null.
   *
   * The retriever reports the container's `mvhd` creation time as
   * `yyyyMMdd'T'HHmmss.SSS'Z'` — the same field ffprobe calls `creation_time`,
   * so a phone and a desktop write the same `captured_at`. A muxer that wrote
   * no date leaves the MP4 epoch (1904) or the Unix one, and neither is a
   * capture time.
   */
  fun captureTimeOf(raw: String?): String? {
    if (raw == null) return null
    val match = Regex("""^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3}))?Z?$""").find(raw.trim())
      ?: return null
    val (y, mo, d, h, mi, s, ms) = match.destructured
    val year = y.toInt()
    if (year <= 1970) return null
    return "$y-$mo-${d}T$h:$mi:$s.${ms.ifEmpty { "0" }.padEnd(3, '0')}Z"
  }
}
