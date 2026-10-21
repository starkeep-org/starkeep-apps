/**
 * Reading a camera-roll asset with its location intact.
 *
 * ## What Android does without this
 *
 * An app reading photos or videos through MediaStore without
 * `ACCESS_MEDIA_LOCATION` gets a copy with the location fields zeroed: EXIF GPS
 * in a photograph, the `©xyz` atom in a video. The byte count is unchanged, so
 * nothing looks wrong, and this app hashed, uploaded and stored that copy as
 * the original. A device test on 2026-10-21 found 24 zeroed bytes in a clip's
 * `©xyz` atom.
 *
 * With the permission granted, a read through a URI carrying
 * `requireOriginal=1` (what `MediaStore.setRequireOriginal` appends) returns
 * the real bytes. Every reader in this app goes through the content resolver —
 * the hash, both uploads, the EXIF read, the poster frame — so marking the URI
 * once, at import, fixes all of them.
 *
 * ## Why only at import, and only new assets
 *
 * An asset's object key is the hash of the bytes read at import. An alias
 * recorded before this fix names the redacted bytes, so it keeps its unmarked
 * URI: switching it would make every later read disagree with its key.
 */

const REQUIRE_ORIGINAL = "requireOriginal=1";

/** The URI with `requireOriginal=1`, for a MediaStore URI; anything else unchanged. */
export function requireOriginalUri(uri: string): string {
  if (!uri.startsWith("content://media/")) return uri;
  if (/[?&]requireOriginal=1(&|$)/.test(uri)) return uri;
  return `${uri}${uri.includes("?") ? "&" : "?"}${REQUIRE_ORIGINAL}`;
}

/**
 * Whether to ask for the location permission now.
 *
 * Asked once per launch, and only once media access itself is granted: the
 * system ties it to the photos permission, and asking for it alone on a phone
 * that has refused the photos permission would be a second refusal for nothing.
 */
export function shouldAskForMediaLocation(state: {
  readonly mediaGranted: boolean;
  readonly locationGranted: boolean;
  readonly askedThisLaunch: boolean;
}): boolean {
  return state.mediaGranted && !state.locationGranted && !state.askedThisLaunch;
}
