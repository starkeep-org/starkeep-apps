package app.starkeep.avif

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import com.radzivon.bartoshyk.avif.coder.AvifChromaSubsampling
import com.radzivon.bartoshyk.avif.coder.AvifSpeed
import com.radzivon.bartoshyk.avif.coder.AvifSurfaceMode
import com.radzivon.bartoshyk.avif.coder.HeifCoder
import com.radzivon.bartoshyk.avif.coder.PreciseMode
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.sharedobjects.SharedRef
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The one thing a phone cannot do in JavaScript: write an AVIF.
 *
 * ## Why this module is encode-only
 *
 * The decode is already paid for. `expo-image` decodes every tile this app
 * paints, and `Image.loadAsync(source, { maxWidth, maxHeight })` hands back an
 * `ImageRef` — on Android an `expo.modules.image.Image`, which is a
 * `SharedRef<Drawable>`. So the derivation pass decodes once, at the largest
 * rung this device produces, and this module encodes down from that one bitmap.
 *
 * Nothing here reads a file, opens a `content://` URI or touches MediaStore.
 * A second decoder in the app would be a second thing that can disagree about
 * what a file contains, which is the argument `thumbHashFor` already makes.
 *
 * ## Why the parameter is `SharedRef<Drawable>` and not `expo.modules.image.Image`
 *
 * Declaring the concrete class would mean a compile dependency on expo-image
 * from a module that needs nothing else from it. It is also unnecessary:
 * `SharedRefTypeConverter` checks a `SharedRef<T>` parameter by asking whether
 * `T` is assignable from the *referent's* class, so any module's `SharedRef`
 * holding a `Drawable` converts. The type check still happens — a `SharedRef`
 * holding something else is rejected with `IncorrectRefTypeException` rather
 * than reaching the encoder.
 *
 * ## Why the bytes go to a path rather than back across the bridge
 *
 * The caller wants them in object storage under a content-addressed key it can
 * only compute once the bytes exist, so they have to land *somewhere* first.
 * Writing them here keeps the encode's output on the thread that produced it,
 * and leaves the boundary carrying four integers.
 *
 * ## The encoder, and what it costs
 *
 * `awxkee/avif-coder` — libavif with an aom encoder, MIT, on Maven Central as
 * `io.github.awxkee:avif-coder`. Measured from the 2.2.1 AAR, it adds 12.69 MB
 * to the `arm64-v8a` payload, of which 4.90 MB is HEIC and HEVC that nothing
 * here encodes; the library exposes no build flag to drop them.
 *
 * The platform alternative was rejected. Android mandates an AVIF *encoder*
 * from Android 14 but exposes no `AvifWriter` to match `HeifWriter`, so using
 * it means driving `MediaCodec` for AV1 and writing the MIAF container by hand
 * — and a subtly malformed container is a corrupt rendition that syncs to every
 * node and is detected by nothing the system currently checks.
 *
 * **Bundling the encoder also removes the Android 14 floor.** avif-coder's
 * minSdk is 24, which is this app's, so every handset that runs Starkeep can
 * derive. The gate that remains is `requireOptionalNativeModule` returning null
 * on a development client built before this module existed.
 */
class StarkeepAvifModule : Module() {
  /** What one encode produced. Integers only; the bytes are at the caller's path. */
  class EncodeResult(
    @Field val width: Int = 0,
    @Field val height: Int = 0,
    @Field val bytes: Int = 0,
  ) : Record

  /**
   * One coder for the module's lifetime.
   *
   * `HeifCoder`'s companion `init` is what calls `System.loadLibrary("coder")`,
   * so the first instantiation is the one that pays for linking ~12 MB of
   * native code. Holding it means the second rung of a record — and every
   * record after the first — does not.
   */
  private val coder by lazy { HeifCoder() }

  override fun definition() = ModuleDefinition {
    Name("StarkeepAvif")

    /**
     * Encode `source` as AVIF at no more than `maxLongEdge`, writing to `path`.
     *
     * `AsyncFunction` rather than `Function`, so the encode runs on the module
     * queue instead of the JavaScript thread. An AVIF encode is the most
     * expensive thing this app does per photograph, and holding the JS thread
     * for it would freeze the grid it exists to fill.
     */
    AsyncFunction("encodeAsync") { source: SharedRef<Drawable>, path: String, maxLongEdge: Int, quality: Int ->
      // Never upscales: a class emits `min(original, class maximum)`, which is
      // rule 1 of the ladder. Enforced here as well as in the caller's
      // arithmetic, because an encoder that silently enlarged would produce a
      // rung whose stored dimensions describe more pixels than the source had.
      val bitmap = scaledForEncode(source.ref, maxLongEdge)
      val encoded = coder.encodeAvif(
        bitmap,
        quality = quality,
        // Fastest. The rung this produces is one a person is waiting on — the
        // grid cannot draw without it — and `derive-ladder-cheap` budgets ten
        // seconds for a record's whole cheap tier.
        speed = AvifSpeed.TEN,
        preciseMode = PreciseMode.LOSSY,
        // Heuristic, which is what matches the other nodes: `sharp` keeps alpha
        // for a source that has it and drops it for one that does not, and the
        // heuristic here decides the same way from the same pixels.
        surfaceMode = AvifSurfaceMode.AUTO,
        // **Set rather than left to the library**, for the reason
        // `derive-ladder.ts` sets it on the `sharp` side: full-resolution chroma
        // emits AV1 profile 1 instead of Main — the narrower of the two profiles
        // decoders actually implement — and costs 38% more bytes for a
        // difference nobody can see in a photograph. A phone-derived rung has to
        // be the same kind of file as a node-derived one.
        avifChromaSubsampling = AvifChromaSubsampling.YUV420,
      )

      val file = File(path.removePrefix("file://"))
      file.parentFile?.mkdirs()
      file.writeBytes(encoded)

      EncodeResult(width = bitmap.width, height = bitmap.height, bytes = encoded.size)
    }
  }

  /**
   * The drawable as a bitmap the encoder will accept, at no more than
   * `maxLongEdge`.
   *
   * Two conversions are load-bearing rather than defensive:
   *
   *  - **A hardware bitmap has no readable pixels.** Glide returns one on API 26
   *    and above whenever it can, and avif-coder answers such a bitmap with
   *    `HardwareBitmapIsNotImplementedException` — its pixels live in graphics
   *    memory that no CPU encoder can address. The copy is what makes them
   *    readable, and it is why this is not simply `(ref as BitmapDrawable).bitmap`.
   *  - **A drawable need not be a `BitmapDrawable` at all.** `ImageLoadTask`
   *    asks Glide for a `Drawable`, which for an animated source is not backed
   *    by a single bitmap, so the general case is drawn onto a canvas.
   */
  private fun scaledForEncode(drawable: Drawable, maxLongEdge: Int): Bitmap {
    val source = readableBitmap(drawable)
    val longEdge = max(source.width, source.height)
    if (maxLongEdge <= 0 || longEdge <= maxLongEdge) return source

    val scale = maxLongEdge.toDouble() / longEdge
    // At least one pixel on each axis: a 10:1 panorama scaled to a thumbnail
    // rounds its short edge towards zero, and a zero-height bitmap is a crash
    // rather than a small picture.
    val width = max(1, (source.width * scale).roundToInt())
    val height = max(1, (source.height * scale).roundToInt())
    return Bitmap.createScaledBitmap(source, width, height, true)
  }

  private fun readableBitmap(drawable: Drawable): Bitmap {
    val direct = (drawable as? BitmapDrawable)?.bitmap
    if (direct != null) {
      return if (direct.config == Bitmap.Config.HARDWARE) {
        direct.copy(Bitmap.Config.ARGB_8888, false) ?: drawOnto(drawable)
      } else {
        direct
      }
    }
    return drawOnto(drawable)
  }

  private fun drawOnto(drawable: Drawable): Bitmap {
    val width = max(1, drawable.intrinsicWidth)
    val height = max(1, drawable.intrinsicHeight)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    drawable.setBounds(0, 0, width, height)
    drawable.draw(canvas)
    return bitmap
  }
}
