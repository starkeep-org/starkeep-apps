package app.starkeep.mediahash

import java.io.InputStream
import java.security.MessageDigest

/**
 * SHA-256 over a stream, one buffer at a time.
 *
 * Split from the module so a JVM test can run it without a `Context`. The
 * module's only other job is opening the stream.
 */
object StreamingSha256 {
  /**
   * One megabyte: large enough that the per-read cost of a content provider
   * disappears, and small enough that the buffer is nothing next to the
   * hundreds of megabytes this exists to avoid holding.
   */
  const val BUFFER_BYTES = 1 shl 20

  data class Digest(val hex: String, val sizeBytes: Long)

  fun of(input: InputStream): Digest {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(BUFFER_BYTES)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      digest.update(buffer, 0, read)
      total += read
    }
    return Digest(toHex(digest.digest()), total)
  }

  /**
   * Lowercase hex, two digits per byte, to match `sha256Bytes` in
   * `src/platform.ts`. The digest is the object storage key, so a different
   * spelling of the same hash would be a different key.
   */
  private fun toHex(bytes: ByteArray): String {
    val out = StringBuilder(bytes.size * 2)
    for (byte in bytes) {
      val value = byte.toInt() and 0xff
      out.append(HEX[value ushr 4]).append(HEX[value and 0x0f])
    }
    return out.toString()
  }

  private val HEX = "0123456789abcdef".toCharArray()
}
