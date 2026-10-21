package app.starkeep.mediahash

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RangeUploadTest {
  private val bytes = ByteArray(5_000_000) { (it % 239).toByte() }

  @Test
  fun `copies exactly the range, across buffers`() {
    val out = ByteArrayOutputStream()
    RangeUpload.copyRange(ByteArrayInputStream(bytes), 1_234_567, 2_500_000, out)
    assertArrayEquals(bytes.copyOfRange(1_234_567, 1_234_567 + 2_500_000), out.toByteArray())
  }

  @Test
  fun `skips through a stream whose skip returns nothing`() {
    // Some content providers' streams return 0 from skip without being at the
    // end; the copier must read past the offset instead of looping forever.
    val stubborn = object : InputStream() {
      private val inner = ByteArrayInputStream(bytes)

      override fun read(): Int = inner.read()

      override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, len)

      override fun skip(n: Long): Long = 0
    }
    val out = ByteArrayOutputStream()
    RangeUpload.copyRange(stubborn, 10_000, 100, out)
    assertArrayEquals(bytes.copyOfRange(10_000, 10_100), out.toByteArray())
  }

  @Test
  fun `refuses a file shorter than the range`() {
    assertThrows(IOException::class.java) {
      RangeUpload.copyRange(ByteArrayInputStream(bytes), 4_999_000, 2_000, ByteArrayOutputStream())
    }
    assertThrows(IOException::class.java) {
      RangeUpload.copyRange(ByteArrayInputStream(bytes), 6_000_000, 1, ByteArrayOutputStream())
    }
  }
}
