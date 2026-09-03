/**
 * The ~25-byte placeholder every record carries, and where the phone gets one.
 *
 * ## Why this device has to produce its own
 *
 * `thumb_hash` is written during derivation, and this device derives nothing.
 * So a photograph imported from this phone's own camera roll had no placeholder
 * at all until some other node ran `sharp` over it and synced the column back —
 * which is a round trip through the cloud to describe a file sitting in local
 * storage. Until that round trip completed there was nothing to paint but an
 * empty rectangle.
 *
 * That is the state the rendition plan removes. **The ThumbHash is the floor:**
 * no surface paints an empty placeholder, because every record has one of these
 * from the moment it is imported.
 *
 * ## Why the encoder is injected rather than imported
 *
 * It is a native call. `Image.generateThumbhashAsync` decodes through Glide on
 * Android and through the platform decoder on iOS, so nothing here runs in
 * Node — and everything else in this file's neighbourhood is decidable against
 * fakes. Passing the encoder in keeps the backfill's walk, its batching and its
 * completion rule testable, and confines the untestable part to one function in
 * `platform.ts`.
 *
 * ## Why the phone's hash and a `sharp` node's hash are the same thing
 *
 * They have to be: the column syncs, so a record can be hashed on one node and
 * painted on another, and a decoder handed the wrong shape of string paints
 * nothing rather than something slightly different.
 *
 * Read on both sides, they agree. `derive-ladder.ts:computeThumbHash` resizes
 * to fit inside 100x100, calls `rgbaToThumbHash`, and base64-encodes the
 * result. `expo-image`'s `generateThumbhashAsync` resizes to a longest edge of
 * 100 keeping the aspect ratio, calls its own Kotlin port of the same
 * `rgbaToThumbHash`, and returns `Base64.encodeToString(…, NO_WRAP)`. Same
 * input bound, same algorithm, same encoding — and `NO_WRAP` matters, because a
 * line-wrapped base64 would decode fine in some readers and not in others.
 *
 * ## Nothing decodes one in JavaScript
 *
 * The plan this implements expected to add the `thumbhash` npm package to the
 * bundle and convert its RGBA output into something `<Image>` could paint.
 * **That is not needed.** `expo-image` takes the base64 string directly as
 * `placeholder={{ thumbhash }}` and decodes it natively — `resolveHashString`
 * turns it into a `thumbhash:/…` URI and `ThumbhashDecoder` produces the
 * bitmap. So the render path costs no dependency, no JavaScript decode per tile
 * and no data URL per tile.
 *
 * The web app still decodes in JavaScript, because a browser has no such
 * component. That is a difference in what the two platforms provide, not a
 * difference in what is stored.
 */

/**
 * Turn the bytes at a URI into a base64 ThumbHash, or answer null.
 *
 * Null rather than a throw for anything the decoder could not read. A
 * photograph with no placeholder is the state that already exists everywhere in
 * this library, so failing to produce one must cost exactly nothing — never an
 * import, and never a backfill pass that would then repeat its own failure on
 * every app open.
 *
 * The URI is whatever the platform can open: a `content://` camera-roll asset,
 * or a `file://` blob this node fetched. Both are the ordinary case.
 */
export type ThumbHashEncoder = (uri: string) => Promise<string | null>;

/**
 * How many records one ThumbHash backfill pass covers.
 *
 * Twelve, and half the EXIF backfill's twenty-four because the two passes pay
 * for different things. The EXIF pass reads a header — one file read, then a
 * walk over a few kilobytes of segment chain. This one **decodes a photograph**:
 * Glide reads the file, produces a bitmap, scales it to 100 px and encodes 25
 * bytes. On a 12-megapixel still that is real work on a real thread, and a
 * batch that holds the JavaScript thread long enough to drop frames is worse
 * than a batch that takes two app opens to finish.
 *
 * Deliberately not tuned against a measurement, because the measurement wants a
 * handset — see the plan's list of what remains unmeasured. Twelve is the
 * conservative half of a number that was itself sized for a cheaper pass.
 */
export const THUMB_HASH_BACKFILL_LIMIT = 12;
