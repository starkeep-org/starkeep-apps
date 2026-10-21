package app.starkeep.mediahash

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingSha256Test {
  @Test
  fun `hashes the empty stream to the known empty digest`() {
    val digest = StreamingSha256.of(ByteArrayInputStream(ByteArray(0)))
    assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", digest.hex)
    assertEquals(0L, digest.sizeBytes)
  }

  @Test
  fun `matches a one-shot digest across several buffers`() {
    // Larger than two buffers and not a multiple of one, so the loop's partial
    // final read is exercised.
    val bytes = ByteArray(StreamingSha256.BUFFER_BYTES * 2 + 12_345) { (it % 251).toByte() }
    val digest = StreamingSha256.of(ByteArrayInputStream(bytes))
    assertEquals(oneShot(bytes), digest.hex)
    assertEquals(bytes.size.toLong(), digest.sizeBytes)
  }

  @Test
  fun `survives a stream that returns short reads`() {
    // A content provider may return fewer bytes than asked for on any read.
    val bytes = ByteArray(100_000) { (it * 7).toByte() }
    val digest = StreamingSha256.of(Trickle(bytes, 999))
    assertEquals(oneShot(bytes), digest.hex)
    assertEquals(bytes.size.toLong(), digest.sizeBytes)
  }

  @Test
  fun `cuts parts at exactly the part size across short reads`() {
    // Parts that straddle the one-megabyte buffer, read in odd-sized trickles,
    // so a boundary off by one byte would show as a wrong part digest.
    val part = 3L * 1024 * 1024 + 7
    val bytes = ByteArray((part * 2 + 5).toInt()) { (it % 241).toByte() }
    val digest = StreamingSha256.withParts(Trickle(bytes, 65_521), part)
    assertEquals(oneShot(bytes), digest.hex)
    assertEquals(bytes.size.toLong(), digest.sizeBytes)
    assertEquals(
      listOf(
        oneShot(bytes.copyOfRange(0, part.toInt())),
        oneShot(bytes.copyOfRange(part.toInt(), (2 * part).toInt())),
        oneShot(bytes.copyOfRange((2 * part).toInt(), bytes.size)),
      ),
      digest.partHexes,
    )
  }

  @Test
  fun `gives an exact multiple no empty trailing part, and an empty file one empty part`() {
    val bytes = ByteArray(2 * 1000) { it.toByte() }
    assertEquals(2, StreamingSha256.withParts(ByteArrayInputStream(bytes), 1000).partHexes.size)
    assertEquals(
      listOf(oneShot(ByteArray(0))),
      StreamingSha256.withParts(ByteArrayInputStream(ByteArray(0)), 1000).partHexes,
    )
  }

  private fun oneShot(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  private class Trickle(private val bytes: ByteArray, private val most: Int) : InputStream() {
    private var at = 0

    override fun read(): Int = if (at < bytes.size) bytes[at++].toInt() and 0xff else -1

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      if (at >= bytes.size) return -1
      val count = minOf(length, most, bytes.size - at)
      System.arraycopy(bytes, at, buffer, offset, count)
      at += count
      return count
    }
  }
}
