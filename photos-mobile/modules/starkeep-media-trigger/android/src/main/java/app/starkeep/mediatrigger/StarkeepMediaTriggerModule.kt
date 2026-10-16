package app.starkeep.mediatrigger

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The JavaScript handle on {@link MediaTriggerWorker}.
 *
 * One call. Everything the trigger does happens in the worker, outside any
 * React instance, so the module only has to arm it.
 */
class StarkeepMediaTriggerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StarkeepMediaTrigger")

    AsyncFunction("arm") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      MediaTriggerWorker.arm(context.applicationContext)
    }
  }
}
