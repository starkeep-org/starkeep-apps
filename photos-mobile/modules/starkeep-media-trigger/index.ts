/**
 * The JavaScript face of {@link StarkeepMediaTriggerModule}.
 *
 * `arm` asks the OS to run the background task when an image or video lands in
 * the media store, in addition to Expo's periodic window. The worker behind it
 * runs the same task `background-task.ts` defines, so nothing on the JS side
 * changes except the call that arms it.
 */

import { requireOptionalNativeModule } from "expo";

export interface StarkeepMediaTrigger {
  /** Arm the trigger. A no-op when a trigger is already waiting or running. */
  arm(): Promise<void>;
}

/**
 * Null when the native module is not in the binary, for the reason the timer
 * module gives: a development client built before this module existed must
 * still launch.
 */
export default requireOptionalNativeModule<StarkeepMediaTrigger>("StarkeepMediaTrigger");
