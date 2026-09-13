/**
 * Start the derivation ingest watch when the server process starts.
 *
 * This was `instrumentation.ts`, the previous framework's one hook that ran at
 * server start rather than on a request. The reason it exists has not changed:
 * derivation used to be triggered from a React effect in a browser tab, so a
 * bulk copy into a watched folder produced a library of originals with no
 * renditions and no queued work until somebody opened the app. The local server
 * is a long-lived supervised process — admin-web starts it detached from the
 * manifest's `localRun` and it runs until explicitly stopped — so its start is
 * the right moment to begin, and a tab has nothing to do with it.
 *
 * What did change is that it is now an ordinary function `src/serve.ts` calls.
 * The hook shipped as a framework entry point whose chunk graph the cloud
 * bundler did not trace, which took forty lines of `.nft.json` copying in
 * `infra/build-bundle.ts` to repair — and the failure it repaired was a Lambda
 * that answered `{"message":"Server failed to respond."}` to every request,
 * including the sign-in page, with the cause only in CloudWatch. A call from
 * the entry that needs it cannot go missing that way.
 *
 * Its own module rather than a block inside `serve.ts` so a test can drive it
 * without starting a server.
 */

/** Whether the watch was started. `false` means it was skipped or it failed. */
export async function startIngestWatchIfLocal(): Promise<boolean> {
  // Cloud derivation is on demand and bounded to what a viewer is looking at,
  // because the resize function has a third of a core and thirty seconds. A
  // whole-library sweep in that shape would time out having done and discarded
  // its work.
  if (process.env.STARKEEP_APP_CLIENT_MODE === "cloud") return false;

  try {
    const { loadAppCredentials } = await import("@starkeep/app-client");
    const creds = await loadAppCredentials("photos");
    if (!creds) {
      // Not installed here yet. Nothing is broken — there is simply no data
      // plane to sweep, and the install writes the credential.
      return false;
    }
    const { startIngestWatch } = await import("./derivation/ingest-watch.js");
    startIngestWatch(creds.dataServerUrl);
    return true;
  } catch (err) {
    // Never fail a server start over background work. A sweep that does not
    // begin is a library that fills in when someone presses the button; a
    // server that will not boot is an app nobody can open.
    console.warn("[derive] could not start the ingest watch:", err);
    return false;
  }
}
