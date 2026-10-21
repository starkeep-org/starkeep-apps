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

  /** The whole-file digest and the digest of each `partBytes` part, from one read. */
  data class PartsDigest(val hex: String, val sizeBytes: Long, val partHexes: List<String>)

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
   * Hash a stream whole and in parts of exactly `partBytes`, the last shorter.
   *
   * One read, because the part digests are what S3 checks and the whole-file
   * digest is what the object key names. Two reads could pair the parts of one
   * version of a file with the hash of another. An empty stream is one empty
   * part, as S3 counts it.
   */
  fun withParts(input: InputStream, partBytes: Long): PartsDigest {
    require(partBytes > 0) { "partBytes must be positive" }
    val whole = MessageDigest.getInstance("SHA-256")
    var part = MessageDigest.getInstance("SHA-256")
    val partHexes = ArrayList<String>()
    val buffer = ByteArray(BUFFER_BYTES)
    var total = 0L
    var inPart = 0L
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      whole.update(buffer, 0, read)
      total += read
      var offset = 0
      while (offset < read) {
        val take = minOf(partBytes - inPart, (read - offset).toLong()).toInt()
        part.update(buffer, offset, take)
        inPart += take
        offset += take
        if (inPart == partBytes) {
          partHexes.add(toHex(part.digest()))
          part = MessageDigest.getInstance("SHA-256")
          inPart = 0
        }
      }
    }
    if (inPart > 0 || partHexes.isEmpty()) partHexes.add(toHex(part.digest()))
    return PartsDigest(toHex(whole.digest()), total, partHexes)
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
