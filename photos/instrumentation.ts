/**
 * Next's one hook that runs when the server process starts, rather than when a
 * request arrives.
 *
 * That distinction is the whole reason this file exists. Derivation used to be
 * triggered from a React effect in a browser tab, so a bulk copy into a watched
 * folder produced a library of originals with no renditions and no queued work
 * until somebody opened the app. The Next server, though, is already a
 * long-lived supervised process — admin-web starts it detached from the
 * manifest's `localRun` block and it runs until explicitly stopped — so its
 * start is the right moment to begin, and a tab has nothing to do with it.
 */

export async function register(): Promise<void> {
  // Node only. Next also runs this hook in its edge runtime, where none of
  // `worker_threads`, `node:fs` or a long-lived subscription exist.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Cloud derivation is on demand and bounded to what a viewer is looking at,
  // because the resize function has a third of a core and thirty seconds. A
  // whole-library sweep in that shape would time out having done and discarded
  // its work.
  if (process.env.STARKEEP_APP_CLIENT_MODE === "cloud") return;

  try {
    const { loadAppCredentials } = await import("@starkeep/app-client");
    const creds = await loadAppCredentials("photos");
    if (!creds) {
      // Not installed here yet. Nothing is broken — there is simply no data
      // plane to sweep, and the install writes the credential.
      return;
    }
    const { startIngestWatch } = await import("./src/derivation/ingest-watch");
    startIngestWatch(creds.dataServerUrl);
  } catch (err) {
    // Never fail a server start over background work. A sweep that does not
    // begin is a library that fills in when someone presses the button; a
    // server that will not boot is an app nobody can open.
    console.warn("[derive] could not start the ingest watch:", err);
  }
}
