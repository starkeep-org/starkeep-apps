package app.starkeep.timer

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A delay that fires in a headless process.
 *
 * ## Why this module exists at all
 *
 * React Native drives JavaScript timers from a `Choreographer` frame callback
 * (`JavaTimerManager` posts through `ReactChoreographer`, which posts to the
 * platform `Choreographer`). A process started for `SystemJobService` has no
 * window, and a handset with the screen off produces no vsync, so the frame
 * callback never runs and `setTimeout` never fires. Measured on a Pixel 5:
 * timers armed at five and twenty seconds had not fired three minutes later,
 * while `Network.getNetworkStateAsync()` resolved in five milliseconds in the
 * same context. The runtime is alive; the frame source is not.
 *
 * That leaves the app with no way to bound anything in a background window,
 * which is the one context where an unbounded call is expensive: WorkManager
 * cancels a wedged worker after ten minutes, and ten minutes is the *entire*
 * daily execution allowance Android grants an app in the RARE standby bucket.
 *
 * ## Why a `ScheduledThreadPoolExecutor`
 *
 * It schedules against `System.nanoTime` on a thread of its own and never
 * touches the display, the main looper or any coroutine scope the OS may cancel
 * when the app loses the foreground. A `Handler` on the main looper would work
 * too, but it would queue behind whatever the main thread is doing, and the
 * main thread in a headless process is the one running the React instance.
 *
 * The thread is a daemon so a pending delay can never be the reason the process
 * stays alive.
 */
class StarkeepTimerModule : Module() {
  private class Pending(val promise: Promise) {
    /** Whoever wins this decides the promise. Set once, by the firing or by the cancel. */
    val settled = AtomicBoolean(false)
    @Volatile
    var future: ScheduledFuture<*>? = null
  }

  private val scheduler = ScheduledThreadPoolExecutor(1) { runnable ->
    Thread(runnable, "starkeep-timer").apply { isDaemon = true }
  }.apply { removeOnCancelPolicy = true }

  private val pending = ConcurrentHashMap<Int, Pending>()

  /**
   * Ids cancelled before the delay that owns them was registered.
   *
   * `Function` runs on the JavaScript thread and `AsyncFunction` runs on the
   * module queue, so a `cancel` can genuinely overtake the `delay` it cancels.
   * Without this set that delay would arm anyway and fire after the caller had
   * given up on it, which is precisely the bug `clearTimeout` exists to prevent.
   */
  private val cancelledEarly: MutableSet<Int> = Collections.synchronizedSet(mutableSetOf())

  override fun definition() = ModuleDefinition {
    Name("StarkeepTimer")

    // Resolves true once `ms` has passed, and false if cancelled first.
    // Resolving rather than rejecting on cancellation, so the caller's promise
    // always settles and a race the work won leaves nothing pending.
    AsyncFunction("delay") { id: Int, ms: Int, promise: Promise ->
      if (cancelledEarly.remove(id)) {
        promise.resolve(false)
      } else {
        val entry = Pending(promise)
        // Registered before it is scheduled, so a delay of zero cannot fire
        // into an empty map and leave its promise pending forever.
        pending[id] = entry
        entry.future = scheduler.schedule(
          {
            if (entry.settled.compareAndSet(false, true)) {
              pending.remove(id)
              promise.resolve(true)
            }
          },
          ms.toLong(),
          TimeUnit.MILLISECONDS
        )
      }
    }

    Function("cancel") { id: Int ->
      val entry = pending.remove(id)
      if (entry == null) {
        cancelledEarly.add(id)
      } else if (entry.settled.compareAndSet(false, true)) {
        entry.future?.cancel(false)
        entry.promise.resolve(false)
      }
    }

    OnDestroy {
      scheduler.shutdownNow()
      pending.clear()
      cancelledEarly.clear()
    }
  }
}
