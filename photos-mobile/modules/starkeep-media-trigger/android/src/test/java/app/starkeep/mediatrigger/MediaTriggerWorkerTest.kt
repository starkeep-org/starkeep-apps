package app.starkeep.mediatrigger

import android.content.Context
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The trigger's scheduling and the worker's run, against WorkManager's test
 * implementation.
 *
 * What these tests cannot show is that Android starts the job when a photo
 * lands. The test scheduler only reports constraints as met when told to.
 * That part is verified on a handset; see
 * `findings-phone-photo-not-synced-2026-10-16.md`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MediaTriggerWorkerTest {
  private lateinit var context: Context
  private lateinit var workManager: WorkManager

  /** A host that records what the worker asked of it. */
  private class FakeHost(
    var foreground: Boolean = false,
    var failWith: Exception? = null,
  ) : MediaTriggerWorker.Host {
    var runs = 0

    override fun inForeground(): Boolean = foreground

    override suspend fun runTask(context: Context) {
      runs += 1
      failWith?.let { throw it }
    }
  }

  private var host = FakeHost()

  /** Builds every worker with the current [host], as WorkManager would. */
  private val factory = object : WorkerFactory() {
    override fun createWorker(
      appContext: Context,
      workerClassName: String,
      workerParameters: WorkerParameters,
    ): ListenableWorker = MediaTriggerWorker(appContext, workerParameters, host)
  }

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    WorkManagerTestInitHelper.initializeTestWorkManager(
      context,
      Configuration.Builder()
        .setExecutor(SynchronousExecutor())
        .setWorkerFactory(factory)
        .build(),
    )
    workManager = WorkManager.getInstance(context)
  }

  private fun uniqueWork(): List<WorkInfo> =
    workManager.getWorkInfosForUniqueWork(MediaTriggerWorker.WORK_NAME).get()

  /** Runs `doWork` directly, outside the unique chain. */
  private fun runWorker(): ListenableWorker.Result = runBlocking {
    TestListenableWorkerBuilder<MediaTriggerWorker>(context)
      .setWorkerFactory(factory)
      .build()
      .doWork()
  }

  @Test
  fun `the request triggers on images and video, without a network constraint`() {
    val constraints = MediaTriggerWorker.request().workSpec.constraints

    val triggers = constraints.contentUriTriggers.associate { it.uri to it.isTriggeredForDescendants }
    assertEquals(
      mapOf(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI to true,
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI to true,
      ),
      triggers,
    )
    assertEquals(5_000L, constraints.contentTriggerUpdateDelayMillis)
    assertEquals(60_000L, constraints.contentTriggerMaxDelayMillis)
    assertEquals(NetworkType.NOT_REQUIRED, constraints.requiredNetworkType)
    assertFalse(constraints.requiresCharging())
    assertFalse(constraints.requiresBatteryNotLow())
  }

  @Test
  fun `arming twice keeps the waiting trigger`() {
    MediaTriggerWorker.arm(context)
    val first = uniqueWork().single()

    MediaTriggerWorker.arm(context)

    val after = uniqueWork().single()
    assertEquals(first.id, after.id)
    assertEquals(WorkInfo.State.ENQUEUED, after.state)
  }

  @Test
  fun `arming replaces a trigger that was cancelled`() {
    MediaTriggerWorker.arm(context)
    val cancelled = uniqueWork().single()
    workManager.cancelUniqueWork(MediaTriggerWorker.WORK_NAME).result.get()

    MediaTriggerWorker.arm(context)

    val after = uniqueWork().filter { it.state == WorkInfo.State.ENQUEUED }.single()
    assertNotEquals(cancelled.id, after.id)
  }

  @Test
  fun `a run in the background runs the task once and succeeds`() {
    assertEquals(ListenableWorker.Result.success(), runWorker())
    assertEquals(1, host.runs)
  }

  @Test
  fun `a run in the foreground skips the task`() {
    host = FakeHost(foreground = true)

    assertEquals(ListenableWorker.Result.success(), runWorker())
    assertEquals(0, host.runs)
  }

  @Test
  fun `a task that throws still succeeds, so the next trigger is not failed with it`() {
    host = FakeHost(failWith = IllegalStateException("no node"))

    assertEquals(ListenableWorker.Result.success(), runWorker())
    assertEquals(1, host.runs)
  }

  @Test
  fun `every run arms the next trigger, foreground or not`() {
    for (foreground in listOf(false, true)) {
      workManager.cancelAllWork().result.get()
      workManager.pruneWork().result.get()
      host = FakeHost(foreground = foreground)

      runWorker()

      val next = uniqueWork().single()
      assertEquals(WorkInfo.State.ENQUEUED, next.state)
      assertTrue(next.constraints.contentUriTriggers.isNotEmpty())
    }
  }

  @Test
  fun `a triggered run leaves the next trigger waiting behind it`() {
    MediaTriggerWorker.arm(context)
    val armed = uniqueWork().single()

    WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(armed.id)
    awaitState(armed.id, WorkInfo.State.SUCCEEDED)

    assertEquals(1, host.runs)
    val next = uniqueWork().single { it.id != armed.id }
    assertEquals(WorkInfo.State.ENQUEUED, next.state)
    assertTrue(next.constraints.contentUriTriggers.isNotEmpty())
  }

  /**
   * A CoroutineWorker finishes on its own dispatcher even under a synchronous
   * executor, so a run started through the test driver settles a little later.
   */
  private fun awaitState(id: java.util.UUID, state: WorkInfo.State) {
    val deadline = System.currentTimeMillis() + 5_000
    while (workManager.getWorkInfoById(id).get()?.state != state) {
      check(System.currentTimeMillis() < deadline) {
        "work $id never reached $state; it is ${workManager.getWorkInfoById(id).get()?.state}"
      }
      Thread.sleep(20)
    }
  }
}
