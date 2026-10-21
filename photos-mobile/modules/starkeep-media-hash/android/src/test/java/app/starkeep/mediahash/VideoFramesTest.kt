package app.starkeep.mediahash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoFramesTest {
  @Test
  fun `sizes a landscape poster to the long edge, keeping the aspect and even sides`() {
    assertEquals(640 to 360, VideoFrames.targetSize(1920, 1080, 640))
    assertEquals(1280 to 720, VideoFrames.targetSize(1920, 1080, 1280))
  }

  @Test
  fun `never upscales a source smaller than the rung`() {
    assertEquals(854 to 480, VideoFrames.targetSize(854, 480, 1280))
  }

  @Test
  fun `keeps a portrait poster portrait`() {
    assertEquals(360 to 640, VideoFrames.targetSize(1080, 1920, 640))
  }

  @Test
  fun `rounds an odd side down to even`() {
    val (w, h) = VideoFrames.targetSize(1001, 563, 640)
    assertEquals(0, w % 2)
    assertEquals(0, h % 2)
  }

  @Test
  fun `rotates only a frame that still has the stored shape of a sideways clip`() {
    assertTrue(VideoFrames.needsRotation(1920, 1080, 1920, 1080, 90))
    assertFalse(VideoFrames.needsRotation(1080, 1920, 1920, 1080, 90))
    assertFalse(VideoFrames.needsRotation(1920, 1080, 1920, 1080, 0))
    assertFalse(VideoFrames.needsRotation(1920, 1080, 1920, 1080, 180))
  }

  @Test
  fun `reads the container date as an ISO instant`() {
    assertEquals("2026-09-27T15:02:48.000Z", VideoFrames.captureTimeOf("20260927T150248.000Z"))
    assertEquals("2026-09-27T15:02:48.000Z", VideoFrames.captureTimeOf("20260927T150248Z"))
  }

  @Test
  fun `treats a missing or epoch date as no capture time`() {
    assertNull(VideoFrames.captureTimeOf(null))
    assertNull(VideoFrames.captureTimeOf("19040101T000000.000Z"))
    assertNull(VideoFrames.captureTimeOf("19700101T000000.000Z"))
    assertNull(VideoFrames.captureTimeOf("not a date"))
  }
}
