package app.starkeep.mediahash

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * PUT one byte range of a stream to a presigned URL.
 *
 * Exists because a multipart upload sends a file as fixed-size parts, and
 * expo-file-system's upload task can send only a whole file. The range never
 * exists whole: it is copied from the content resolver's stream to the socket
 * one buffer at a time.
 *
 * `HttpURLConnection` rather than OkHttp, so the module adds no dependency
 * that could disagree with the one React Native bundles.
 */
object RangeUpload {
  /** A completed response, 2xx or not. A 403 from S3 is an answer, not a failure. */
  data class Result(val status: Int, val body: String, val etag: String?)

  /** Most of an error body worth carrying back; S3's code and message lead it. */
  private const val BODY_LIMIT = 8 * 1024

  private const val TIMEOUT_MS = 60_000

  /**
   * Copy `length` bytes starting at `offset` from `input` to `output`.
   *
   * Throws when the stream ends early: a file that shrank since it was hashed
   * would otherwise send a short part, which S3 refuses only after the bytes
   * crossed the network.
   */
  fun copyRange(input: InputStream, offset: Long, length: Long, output: OutputStream) {
    var toSkip = offset
    while (toSkip > 0) {
      val skipped = input.skip(toSkip)
      if (skipped > 0) {
        toSkip -= skipped
        continue
      }
      // `skip` may return 0 without reaching the end; one read tells which.
      if (input.read() < 0) throw IOException("the file ended $toSkip bytes before offset $offset")
      toSkip -= 1
    }
    val buffer = ByteArray(StreamingSha256.BUFFER_BYTES)
    var remaining = length
    while (remaining > 0) {
      val read = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
      if (read < 0) throw IOException("the file ended $remaining bytes before the range did")
      output.write(buffer, 0, read)
      remaining -= read
    }
  }

  /**
   * Send the range and read the response.
   *
   * `onOpen` receives the connection before any byte moves, so a caller can
   * hold it and `disconnect()` it to abort the transfer from another thread.
   */
  fun send(
    input: InputStream,
    offset: Long,
    length: Long,
    url: String,
    headers: Map<String, String>,
    onOpen: (HttpURLConnection) -> Unit,
  ): Result {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "PUT"
      connection.doOutput = true
      connection.connectTimeout = TIMEOUT_MS
      connection.readTimeout = TIMEOUT_MS
      // A fixed length, so the body streams instead of buffering, and S3 gets
      // the Content-Length a presigned PUT requires.
      connection.setFixedLengthStreamingMode(length)
      for ((name, value) in headers) connection.setRequestProperty(name, value)
      onOpen(connection)
      connection.outputStream.use { copyRange(input, offset, length, it) }
      val status = connection.responseCode
      val stream = if (status >= 400) connection.errorStream else connection.inputStream
      val body = stream?.use { readLimited(it) } ?: ""
      return Result(status, body, connection.getHeaderField("ETag"))
    } finally {
      connection.disconnect()
    }
  }

  private fun readLimited(input: InputStream): String {
    val bytes = ByteArray(BODY_LIMIT)
    var total = 0
    while (total < bytes.size) {
      val read = input.read(bytes, total, bytes.size - total)
      if (read < 0) break
      total += read
    }
    return String(bytes, 0, total, Charsets.UTF_8)
  }
}
