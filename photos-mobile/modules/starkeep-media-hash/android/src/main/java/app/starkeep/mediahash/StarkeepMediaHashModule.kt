package app.starkeep.mediahash

import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * SHA-256 of a camera-roll asset, without the asset entering JavaScript.
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
 * ## Why `AsyncFunction`
 *
 * Expo runs an `AsyncFunction` off the JavaScript thread, so a multi-second
 * read of a large video blocks neither the UI nor the timers a background
 * window depends on.
 */
class StarkeepMediaHashModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StarkeepMediaHash")

    AsyncFunction("sha256OfUri") { uri: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val stream = context.contentResolver.openInputStream(Uri.parse(uri))
        ?: throw NoStreamException(uri)
      val digest = stream.use { StreamingSha256.of(it) }
      // A Double, because JS numbers are doubles and a Long would arrive as
      // whatever the bridge decides. Exact up to 2^53 bytes.
      mapOf("hex" to digest.hex, "sizeBytes" to digest.sizeBytes.toDouble())
    }
  }
}

private class NoStreamException(uri: String) :
  CodedException("the content resolver opened no stream for $uri")
