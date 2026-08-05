/**
 * An in-memory expo-file-system, implementing the module's *shape*.
 *
 * Shared between the storage adapter's own tests and the node assembly's, so
 * both exercise the same fake — a second copy would be a second thing that can
 * drift from what expo-file-system actually does.
 *
 * `openHandles` is tracked because a leaked file handle is a real failure on a
 * phone, where the open-file limit is low enough to matter within one session.
 */
import type {
  ExpoDirectory,
  ExpoFile,
  ExpoFileHandle,
  ExpoFileSystem,
} from "../../src/storage/expo-object-storage";

/** In-memory expo-file-system. Tracks handle lifetime, which is a real leak risk. */
export function fakeExpoFs() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const state = {
    openHandles: 0,
    rangedReads: [] as Array<{ offset: number; length: number }>,
    /**
     * Recorded because a move that is secretly a read-and-write is the bug the
     * object store's `putStream` had: it materialized the whole object just to
     * rename it, one line after streaming it to disk to avoid exactly that.
     */
    moves: [] as Array<{ from: string; to: string }>,
    /**
     * Every whole-file read. A `content://` asset can only be read this way, so
     * each entry is the full object in the JS heap — the allocation that has to
     * happen once, lazily, or not at all.
     */
    wholeReads: [] as string[],
  };

  /**
   * Refuse a file handle on a `content://` URI, exactly as expo does.
   *
   * `FileSystemFile.openHandle` dispatches on the resolved implementation and
   * has branches for `JavaFile` and `SAFDocumentFile` only; a MediaStore URI
   * resolves to `ContentProviderFile` and falls to `else -> throw`. Both
   * `readableStream()` and ranged reads go through it.
   *
   * This fake used to stream content URIs perfectly happily, which is why every
   * test passed while every asset on a real handset failed to import. A fake
   * that is more permissive than the thing it stands in for does not merely
   * miss bugs — it actively certifies them.
   */
  function refuseHandleForContentUri(path: string): void {
    if (path.startsWith("content://")) {
      throw new Error(`File handle is not supported for ${path}`);
    }
  }

  const file = (path: string): ExpoFile => ({
    get exists() {
      return files.has(path);
    },
    get size() {
      return files.get(path)?.byteLength ?? null;
    },
    get uri() {
      return path;
    },
    bytesSync() {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`no such file: ${path}`);
      state.wholeReads.push(path);
      return bytes;
    },
    readableStream() {
      refuseHandleForContentUri(path);
      const bytes = files.get(path);
      if (!bytes) throw new Error(`no such file: ${path}`);
      // Chunked, so a consumer that assumes one chunk fails here rather than on
      // a device.
      let at = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(at + 8, bytes.byteLength);
          controller.enqueue(bytes.subarray(at, end));
          at = end;
        },
      });
    },
    writableStream() {
      const chunks: Uint8Array[] = [];
      return new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
        close() {
          const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let at = 0;
          for (const c of chunks) {
            out.set(c, at);
            at += c.byteLength;
          }
          files.set(path, out);
        },
      });
    },
    open(): ExpoFileHandle {
      refuseHandleForContentUri(path);
      const bytes = files.get(path) ?? new Uint8Array();
      state.openHandles += 1;
      const handle: ExpoFileHandle = {
        offset: 0,
        readBytes(length: number) {
          state.rangedReads.push({ offset: handle.offset, length });
          const slice = bytes.subarray(handle.offset, handle.offset + length);
          handle.offset += slice.byteLength;
          return slice;
        },
        close() {
          state.openHandles -= 1;
        },
      };
      return handle;
    },
    create() {
      if (!files.has(path)) files.set(path, new Uint8Array());
    },
    moveSync(destination, options) {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`no such file: ${path}`);
      if (files.has(destination.uri) && !options?.overwrite) {
        throw new Error(`destination already exists: ${destination.uri}`);
      }
      files.set(destination.uri, bytes);
      files.delete(path);
      state.moves.push({ from: path, to: destination.uri });
    },
    delete() {
      files.delete(path);
    },
    async text() {
      return new TextDecoder().decode(files.get(path) ?? new Uint8Array());
    },
    write(contents: string | Uint8Array) {
      files.set(path, typeof contents === "string" ? new TextEncoder().encode(contents) : contents);
    },
  });

  const directory = (path: string): ExpoDirectory => ({
    get exists() {
      // Also true when something lives under it, which is what a real
      // filesystem says: `file.create({ intermediates: true })` brings the
      // parent directories into being, and this fake models that as one map
      // entry for the leaf rather than an entry per level.
      if (dirs.has(path)) return true;
      const under = `${path}/`;
      for (const key of files.keys()) if (key.startsWith(under)) return true;
      for (const key of dirs) if (key.startsWith(under)) return true;
      return false;
    },
    get uri() {
      return path;
    },
    create() {
      dirs.add(path);
    },
    delete() {
      dirs.delete(path);
      // Recursive, as expo's is: a reset that left the objects behind would
      // report an empty node while its disk was still full.
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${path}/`)) files.delete(key);
      }
      for (const key of [...dirs]) {
        if (key.startsWith(`${path}/`)) dirs.delete(key);
      }
    },
    /**
     * The immediate children of this directory, files and subdirectories both.
     *
     * This returned `[]` while nothing walked the tree, which was honest then
     * and became a trap the moment `ExpoObjectStorageAdapter.list()` existed: a
     * reconcile against an empty listing reads as "storage holds nothing" and
     * marks every live row departed. A fake that is *less* capable than the
     * thing it stands in for certifies the caller as working when it does not,
     * which is the same failure this file's own header describes from the
     * permissive direction.
     *
     * Derived from the file and directory keys rather than tracked separately,
     * so a `create({ intermediates: true })` that this fake models as one map
     * entry still lists correctly.
     */
    list() {
      const under = `${path}/`;
      const names = new Set<string>();
      for (const candidate of [...files.keys(), ...dirs]) {
        if (!candidate.startsWith(under)) continue;
        const rest = candidate.slice(under.length);
        if (rest === "") continue;
        names.add(rest.split("/")[0]!);
      }
      return [...names].map((name) => {
        const child = `${path}/${name}`;
        // A name with anything below it is a directory; the leaf is a file.
        // `dirs` alone is not enough, because `file.create({ intermediates })`
        // never registered the parents.
        const hasChildren = [...files.keys(), ...dirs].some((k) =>
          k.startsWith(`${child}/`),
        );
        return hasChildren || (dirs.has(child) && !files.has(child))
          ? directory(child)
          : file(child);
      });
    },
  });

  const fs: ExpoFileSystem = { file, directory };
  return { fs, files, state };
}
