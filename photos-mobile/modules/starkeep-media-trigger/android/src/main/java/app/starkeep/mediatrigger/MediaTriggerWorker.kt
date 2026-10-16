package app.starkeep.mediatrigger

import android.content.Context
import android.provider.MediaStore
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import expo.modules.backgroundtask.BackgroundTaskConsumer
import expo.modules.backgroundtask.BackgroundTaskScheduler
import expo.modules.interfaces.taskManager.TaskServiceProviderHelper
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitAll
import java.util.concurrent.TimeUnit

/**
 * Runs the background task when the media store changes.
 *
 * ## Why this exists beside expo-background-task's worker
 *
 * expo-background-task schedules one periodic request, and an app nobody opens
 * sinks to the RARE standby bucket, where that request ran 4 to 7 hours apart on
 * a Pixel 10a. A photograph taken in between waited for the next window. A
 * content-URI trigger asks the OS to start the work when an image or video is
 * added or changed instead. Google Photos' own trigger on the same phone ran 89
 * seconds after a photograph, with Battery Saver on.
 * See `findings-phone-photo-not-synced-2026-10-16.md`.
 *
 * ## Why it runs the task itself rather than kicking Expo's worker
 *
 * Expo's `runTasks` appends a new periodic request to Expo's unique work chain
 * after every run. Calling it from here would grow that chain by one request per
 * photograph. This worker repeats the part of `runTasks` that matters (find the
 * consumer the JS task registered under, execute it, wait) and leaves Expo's
 * schedule alone. The JS side already keeps one tick per process when both
 * workers deliver at once (`single-flight.ts`).
 *
 * ## Why no network constraint
 *
 * Import and the cheap rungs need no network, and the tick checks the network
 * itself before it syncs. Google Photos' backup job, which does require the
 * network, sat blocked under Battery Saver while its trigger job ran. A network
 * constraint here would block the half of the work that can still happen.
 *
 * ## Why it re-arms itself
 *
 * A content-URI trigger fires once. Each run enqueues the next request first,
 * as a child of itself, so the next change after this run finishes starts the
 * work again. Changes that land while this run is in progress do not fire
 * anything, but the tick's import watermark still picks them up on the next run
 * of either worker.
 */
class MediaTriggerWorker(
  context: Context,
  params: WorkerParameters,
  private val host: Host,
) : CoroutineWorker(context, params) {

  /**
   * What the worker needs from the app around it.
   *
   * A seam for the tests, which run under Robolectric with no React instance
   * and no Expo task service. Production always uses {@link ExpoHost}.
   */
  interface Host {
    /** Whether the app's activity is in the foreground. */
    fun inForeground(): Boolean

    /** Run the background task and return once the JS side reports it finished. */
    suspend fun runTask(context: Context)
  }

  /** The constructor WorkManager's default factory calls, by reflection. */
  constructor(context: Context, params: WorkerParameters) : this(context, params, ExpoHost)

  companion object {
    private const val TAG = "StarkeepMediaTrigger"

    /** The unique work name. Stable across releases, like the JS task's name. */
    const val WORK_NAME = "STARKEEP_MEDIA_TRIGGER"

    /**
     * How long the media store must stay quiet before the work starts.
     *
     * The camera inserts a pending row and then finalizes it, and a burst of
     * shots changes the store many times in a few seconds. Waiting for a quiet
     * spell runs one tick for the burst rather than one per row.
     */
    private const val UPDATE_DELAY_SECONDS = 5L

    /** The longest a stream of changes may postpone the work. */
    private const val MAX_DELAY_SECONDS = 60L

    fun request(): OneTimeWorkRequest {
      val constraints = Constraints.Builder()
        .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
        .addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
        .setTriggerContentUpdateDelay(UPDATE_DELAY_SECONDS, TimeUnit.SECONDS)
        .setTriggerContentMaxDelay(MAX_DELAY_SECONDS, TimeUnit.SECONDS)
        .build()
      return OneTimeWorkRequestBuilder<MediaTriggerWorker>()
        .setConstraints(constraints)
        .build()
    }

    /**
     * Arm the trigger from a launch.
     *
     * KEEP leaves a request that is already waiting or running alone, so
     * calling this on every launch never resets it. A request that finished,
     * failed or was cancelled, for example by a force-stop, is replaced.
     */
    fun arm(context: Context) {
      WorkManager.getInstance(context)
        .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request())
    }
  }

  override suspend fun doWork(): Result {
    Log.i(
      TAG,
      "fired: authorities=${triggeredContentAuthorities} uris=${triggeredContentUris.size}",
    )

    // Before the task, so a run that throws or is stopped still leaves the next
    // change armed. APPEND_OR_REPLACE makes the new request a child of this
    // running one; KEEP would drop it, and REPLACE would cancel this run.
    WorkManager.getInstance(applicationContext)
      .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request())

    // The same rule Expo's worker applies. The open app runs its own catch-up,
    // and a background tick would compete with the screen for the node.
    if (host.inForeground()) {
      Log.i(TAG, "app is in the foreground — skipping")
      return Result.success()
    }

    try {
      host.runTask(applicationContext)
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "task failed: ${e.message}")
    }

    Log.i(TAG, "task finished")
    // Always success. A failed parent fails its children, and the child is the
    // next trigger.
    return Result.success()
  }
}

/**
 * The real host: Expo's foreground flag and Expo's task service.
 *
 * This repeats the part of Expo's `runTasks` that matters (find the consumer
 * the JS task registered under, execute it, wait) without the periodic
 * request `runTasks` appends afterwards. See the class comment on
 * {@link MediaTriggerWorker}.
 */
internal object ExpoHost : MediaTriggerWorker.Host {
  private const val TAG = "StarkeepMediaTrigger"

  override fun inForeground(): Boolean = BackgroundTaskScheduler.inForeground

  override suspend fun runTask(context: Context) {
    val taskService = TaskServiceProviderHelper.getTaskServiceImpl(context)
    if (taskService == null) {
      Log.w(TAG, "no task service in this binary")
      return
    }
    val consumers = taskService.getTaskConsumers(context.packageName)
      .filterIsInstance<BackgroundTaskConsumer>()
    if (consumers.isEmpty()) {
      // The JS task registers on the first launch. Until then there is
      // nothing to run.
      Log.i(TAG, "no background task registered yet")
      return
    }

    consumers.map { consumer ->
      val done = CompletableDeferred<Unit>()
      try {
        consumer.executeTask { done.complete(Unit) }
      } catch (e: Exception) {
        // Completed here as well, because a deferred nobody completes would
        // hold the worker until WorkManager's ten-minute stop.
        Log.e(TAG, "task failed to start: ${e.message}")
        done.complete(Unit)
      }
      done
    }.awaitAll()
  }
}
