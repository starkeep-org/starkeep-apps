package app.starkeep.mediahash

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * SHA-256 of a camera-roll asset, and its upload in parts, without the asset
 * entering JavaScript.
 *
 * ## Why this module exists at all
 *
 * expo-file-system cannot read a MediaStore URI incrementally. `openHandle`
 * has branches for a plain file and a SAF document only, and a MediaStore URI
 * is neither, so the only read JS can make is the whole asset at once.
 * `expo-crypto` hashes only a whole buffer. Together they cap import at what
 * the JS heap can hold, and a 391 MB video is far past that.
 *
 * `ContentResolver.openInputStream` reads the same URI as a stream, and
 * `MessageDigest` hashes a stream. The asset never exists whole anywhere.
 *
 * ## Why each function moves to `Dispatchers.IO`
 *
 * Expo runs an `AsyncFunction` off the JavaScript thread, so a multi-second
 * read of a large video blocks neither the UI nor the timers a background
 * window depends on. But every module's `AsyncFunction` shares one
 * `HandlerThread`, so a sixteen-second part upload on a weak signal would hold
 * every other native call behind it, the AVIF encoder's included, and three
 * concurrent transfers would run one at a time. The `Coroutine` form with
 * `withContext(Dispatchers.IO)` frees that thread while the bytes move.
 */
class StarkeepMediaHashModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StarkeepMediaHash")

    AsyncFunction("sha256OfUri") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
        val digest = open(uri).use { StreamingSha256.of(it) }
        // A Double, because JS numbers are doubles and a Long would arrive as
        // whatever the bridge decides. Exact up to 2^53 bytes.
        mapOf("hex" to digest.hex, "sizeBytes" to digest.sizeBytes.toDouble())
      }
    }

    // The whole-file digest and the multipart part digests, from one read.
    AsyncFunction("sha256PartsOfUri") Coroutine { uri: String, partBytes: Double ->
      withContext(Dispatchers.IO) {
        val digest = open(uri).use { StreamingSha256.withParts(it, partBytes.toLong()) }
        mapOf(
          "hex" to digest.hex,
          "sizeBytes" to digest.sizeBytes.toDouble(),
          "partHexes" to digest.partHexes,
        )
      }
    }

    // One multipart part's PUT. `requestId` names the transfer so that
    // `cancelUpload` can abort it when a background window closes.
    AsyncFunction("uploadRangeOfUri") Coroutine {
      requestId: String,
      uri: String,
      offset: Double,
      length: Double,
      url: String,
      headers: Map<String, String>,
      ->
      withContext(Dispatchers.IO) {
        val started = System.nanoTime()
        val elapsedMs = { (System.nanoTime() - started) / 1_000_000 }
        Log.i(TAG, "$requestId: sending ${length.toLong()} bytes at ${offset.toLong()}")
        try {
          val result = open(uri).use { input ->
            RangeUpload.send(input, offset.toLong(), length.toLong(), url, headers) { connection ->
              active[requestId] = connection
            }
          }
          Log.i(TAG, "$requestId: answered ${result.status} in ${elapsedMs()} ms, etag ${result.etag}")
          mapOf("status" to result.status, "body" to result.body, "etag" to result.etag)
        } catch (err: Exception) {
          Log.w(TAG, "$requestId: failed after ${elapsedMs()} ms: ${err.message}")
          throw err
        } finally {
          active.remove(requestId)
        }
      }
    }

    // What the container says about a video, from the file's own bytes: the
    // length, the display size, and when it was recorded.
    AsyncFunction("videoFactsOfUri") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
        withRetriever(uri) { retriever ->
          val facts = displayFacts(retriever)
          val location = VideoFrames.locationOf(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_LOCATION))
          mapOf(
            "durationMs" to (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0),
            "width" to facts.displayWidth,
            "height" to facts.displayHeight,
            "capturedAt" to VideoFrames.captureTimeOf(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)),
            "gpsLat" to location?.first,
            "gpsLon" to location?.second,
          )
        }
      }
    }

    // One frame at `timeUs`, upright, written as a JPEG at each requested long
    // edge. One decode serves every size.
    AsyncFunction("extractPostersOfUri") Coroutine {
      uri: String,
      timeUs: Double,
      outputs: List<Map<String, Any>>,
      quality: Int,
      ->
      withContext(Dispatchers.IO) {
        withRetriever(uri) { retriever ->
          val facts = displayFacts(retriever)
          val started = System.nanoTime()
          var frame = retriever.getFrameAtTime(timeUs.toLong(), MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            ?: throw NoFrameException(uri)
          if (VideoFrames.needsRotation(frame.width, frame.height, facts.storedWidth, facts.storedHeight, facts.rotation)) {
            val turn = Matrix().apply { postRotate(facts.rotation.toFloat()) }
            val upright = Bitmap.createBitmap(frame, 0, 0, frame.width, frame.height, turn, true)
            frame.recycle()
            frame = upright
          }
          try {
            outputs.map { output ->
              val maxLongEdge = (output["maxLongEdge"] as Number).toInt()
              val path = output["path"] as String
              val (w, h) = VideoFrames.targetSize(frame.width, frame.height, maxLongEdge)
              val scaled = if (w == frame.width && h == frame.height) frame else Bitmap.createScaledBitmap(frame, w, h, true)
              val file = File(path.removePrefix("file://"))
              file.parentFile?.mkdirs()
              FileOutputStream(file).use { scaled.compress(Bitmap.CompressFormat.JPEG, quality, it) }
              if (scaled !== frame) scaled.recycle()
              mapOf("path" to path, "width" to w, "height" to h, "sizeBytes" to file.length().toDouble())
            }.also {
              Log.i(TAG, "posters for $uri: ${it.size} at ${timeUs.toLong()}us in ${(System.nanoTime() - started) / 1_000_000} ms")
            }
          } finally {
            frame.recycle()
          }
        }
      }
    }

    // Whether reads can ask for an asset's unredacted bytes. Without this grant
    // Android zeroes the location fields of every photo and video it hands over.
    Function("mediaLocationGranted") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    // Move camera-roll assets to Android's trash, where the person can restore
    // them for 30 days. Android shows its own confirmation, because an app may
    // not trash media it did not create without one. Answers whether the person
    // confirmed. Main queue, because the confirmation is an activity started
    // for a result.
    AsyncFunction("trashMediaUris") { uris: List<String>, promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || uris.isEmpty()) {
        promise.resolve(false)
        return@AsyncFunction
      }
      if (pendingTrash != null) {
        promise.reject(CodedException("ERR_TRASH_BUSY", "a trash confirmation is already open", null))
        return@AsyncFunction
      }
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val request = MediaStore.createTrashRequest(context.contentResolver, uris.map(Uri::parse), true)
      pendingTrash = promise
      try {
        appContext.throwingActivity.startIntentSenderForResult(request.intentSender, TRASH_REQUEST, null, 0, 0, 0)
      } catch (e: Exception) {
        pendingTrash = null
        promise.reject(CodedException("ERR_TRASH_FAILED", e.message ?: "could not ask to trash", e))
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != TRASH_REQUEST) return@OnActivityResult
      val promise = pendingTrash ?: return@OnActivityResult
      pendingTrash = null
      promise.resolve(payload.resultCode == Activity.RESULT_OK)
    }

    // Disconnecting from this thread makes the uploading thread's write throw,
    // which rejects that transfer's promise.
    Function("cancelUpload") { requestId: String ->
      val connection = active.remove(requestId)
      Log.i(TAG, "$requestId: cancel requested, ${if (connection != null) "disconnecting" else "not in flight"}")
      connection?.disconnect()
    }
  }

  private val active = ConcurrentHashMap<String, HttpURLConnection>()

  /** The open trash confirmation's promise. One at a time, as the dialog is. */
  private var pendingTrash: Promise? = null

  private companion object {
    /** `adb logcat -s StarkeepMultipart` shows every part's native life. */
    const val TAG = "StarkeepMultipart"

    /** Identifies the trash confirmation's result among the activity's others. */
    const val TRASH_REQUEST = 0x5354
  }

  private class DisplayFacts(
    val storedWidth: Int,
    val storedHeight: Int,
    val rotation: Int,
  ) {
    val displayWidth get() = if (rotation % 180 == 0) storedWidth else storedHeight
    val displayHeight get() = if (rotation % 180 == 0) storedHeight else storedWidth
  }

  private fun displayFacts(retriever: MediaMetadataRetriever): DisplayFacts =
    DisplayFacts(
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0,
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0,
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0,
    )

  private fun <T> withRetriever(uri: String, block: (MediaMetadataRetriever) -> T): T {
    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, Uri.parse(uri))
      return block(retriever)
    } finally {
      retriever.release()
    }
  }

  private fun open(uri: String): InputStream {
    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    return context.contentResolver.openInputStream(Uri.parse(uri)) ?: throw NoStreamException(uri)
  }
}

private class NoStreamException(uri: String) :
  CodedException("the content resolver opened no stream for $uri")

private class NoFrameException(uri: String) :
  CodedException("the retriever decoded no frame from $uri")
