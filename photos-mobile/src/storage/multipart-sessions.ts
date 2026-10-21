/**
 * Where this phone remembers its in-progress multipart uploads.
 *
 * ## Why the phone remembers them
 *
 * A large video goes to S3 in 16 MiB parts, and a background window often
 * closes before the last one. Resuming needs the upload id and the ETag of each
 * finished part. The cloud cannot look an upload up by key: that takes
 * `s3:ListBucketMultipartUploads`, which no IAM policy can narrow to one user's
 * keys. So the uploader keeps them, and a window that closes mid-file costs at
 * most one part.
 *
 * ## Why a file and not the node's database
 *
 * The cloud adapter that reads and writes sessions is built before the node
 * opens its database. A session is also disposable: losing one costs a fresh
 * upload, and S3's lifecycle rule aborts the orphan after seven days. One small
 * JSON file, read and written synchronously so two concurrent transfers cannot
 * interleave a read and a write, is enough.
 */

import type { MultipartSessionStore, MultipartUploadSession } from "@starkeep/sync-engine";

/** The file the sessions live in, as two synchronous calls. */
export interface SessionFile {
  /** The file's contents, or null when it does not exist yet. */
  read(): string | null;
  write(contents: string): void;
}

type Sessions = Record<string, MultipartUploadSession>;

function isSession(value: unknown): value is MultipartUploadSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<MultipartUploadSession>;
  return (
    typeof v.uploadId === "string" &&
    Array.isArray(v.partSha256Hex) &&
    v.partSha256Hex.every((h) => typeof h === "string") &&
    typeof v.etags === "object" &&
    v.etags !== null &&
    Object.values(v.etags).every((e) => typeof e === "string")
  );
}

/**
 * Sessions stored in one JSON file. A file that does not parse, or an entry of
 * the wrong shape, reads as no session: the upload starts over, which is the
 * safe direction.
 */
export function createFileMultipartSessions(file: SessionFile): MultipartSessionStore {
  const load = (): Sessions => {
    let parsed: unknown;
    try {
      const text = file.read();
      parsed = text === null ? {} : JSON.parse(text);
    } catch (err) {
      console.warn(`[multipart] the session file is unreadable, so every upload starts over: ${String(err)}`);
      return {};
    }
    if (typeof parsed !== "object" || parsed === null) return {};
    const entries = Object.entries(parsed);
    const kept = entries.filter(([, s]) => isSession(s));
    if (kept.length < entries.length) {
      console.warn(`[multipart] dropped ${entries.length - kept.length} malformed session(s) from the session file`);
    }
    return Object.fromEntries(kept) as Sessions;
  };
  const save = (sessions: Sessions): void => file.write(JSON.stringify(sessions));

  return {
    async get(key) {
      return load()[key] ?? null;
    },
    async set(key, session) {
      save({ ...load(), [key]: session });
    },
    async delete(key) {
      const sessions = load();
      if (!(key in sessions)) return;
      delete sessions[key];
      save(sessions);
    },
  };
}
