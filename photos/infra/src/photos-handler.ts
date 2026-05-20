/**
 * Photos Lambda handler — server-side thumbnail generation for the photos app.
 *
 * POST /data/generate-thumbnail: fetches a source image from S3, runs sharp to
 * produce a thumbnail, creates a new DataRecord for the thumbnail (with
 * content.parentId pointing to the original), and stores the record in DSQL.
 *
 * Environment variables:
 *   STARKEEP_DSQL_HOSTNAME  — Aurora DSQL cluster hostname
 *   STARKEEP_FILES_BUCKET   — S3 bucket name for object storage
 *   STARKEEP_STACK_PREFIX   — stack prefix (e.g. "mystack")
 *   AWS_REGION              — set automatically by Lambda runtime
 */

import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";
import { AuroraDsqlDatabaseAdapter } from "@starkeep/storage-aurora-dsql";
import { S3ObjectStorageAdapter } from "@starkeep/storage-s3";
import { createHLCClock } from "@starkeep/core";
import type { StarkeepId } from "@starkeep/core";
import type {
  DatabaseClientFactory,
  DatabaseClient,
  AuroraDsqlDatabaseAdapterOptions,
} from "@starkeep/storage-aurora-dsql";
import { generateThumbnailRecord } from "../../src/photos-lib/metadata/thumbnail-generator.js";
import { resizeForThumbnail } from "../../src/photos-lib/image-processing/resize.js";
import { ok, clientErr, type APIGatewayEvent } from "./handler-utils.js";

// ---------------------------------------------------------------------------
// DSQL client factory using the Lambda execution role credentials
// ---------------------------------------------------------------------------

class LambdaDsqlClientFactory implements DatabaseClientFactory {
  async createClient(options: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    const { hostname, region } = options;
    const stackPrefix = process.env.STARKEEP_STACK_PREFIX ?? "";
    const dbUser = `${stackPrefix}_app_photos`;

    const createPgClient = async (): Promise<pg.Client> => {
      const signer = new DsqlSigner({ hostname, region });
      const token = await signer.getDbConnectAuthToken();
      const client = new pg.Client({
        host: hostname,
        port: 5432,
        database: options.database ?? "postgres",
        user: dbUser,
        password: token,
        ssl: { rejectUnauthorized: true },
      });
      await client.connect();
      return client;
    };

    let inner = await createPgClient();

    return {
      async query(text, values) {
        try {
          const result = await inner.query(text, values);
          return { rows: result.rows };
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === "28000" || code === "28P01") {
            await inner.end().catch(() => {});
            inner = await createPgClient();
            const result = await inner.query(text, values);
            return { rows: result.rows };
          }
          throw err;
        }
      },
      async end() {
        await inner.end();
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Adapter initialisation — cached across Lambda invocations (warm starts)
// ---------------------------------------------------------------------------

interface Adapters {
  db: AuroraDsqlDatabaseAdapter;
  storage: S3ObjectStorageAdapter;
  clock: ReturnType<typeof createHLCClock>;
}

let adapters: Adapters | null = null;

async function getAdapters(): Promise<Adapters> {
  if (adapters) return adapters;

  const region = process.env.AWS_REGION ?? "us-east-1";
  const dsqlHostname = process.env.STARKEEP_DSQL_HOSTNAME;
  const filesBucket = process.env.STARKEEP_FILES_BUCKET;

  if (!dsqlHostname) throw new Error("STARKEEP_DSQL_HOSTNAME env var is required");
  if (!filesBucket) throw new Error("STARKEEP_FILES_BUCKET env var is required");

  const db = new AuroraDsqlDatabaseAdapter(
    { hostname: dsqlHostname, region },
    new LambdaDsqlClientFactory(),
  );
  await db.init();

  const storage = new S3ObjectStorageAdapter({ bucketName: filesBucket, region });
  const clock = createHLCClock({ nodeId: "cloud-photos-api", wallClockFunction: Date.now });

  adapters = { db, storage, clock };
  return adapters;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayEvent) {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;

    if (method === "OPTIONS") {
      return { statusCode: 200, body: "" };
    }

    // POST /data/generate-thumbnail — create a thumbnail DataRecord for an original.
    if (method === "POST" && path === "/data/generate-thumbnail") {
      const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : (event.body ?? "{}");
      const body = JSON.parse(rawBody) as { targetId?: string; ownerId?: string };
      if (!body.targetId) return clientErr("targetId is required", 400);

      const { db, storage, clock } = await getAdapters();
      const ownerId = body.ownerId ?? "unknown";

      const record = await db.get(body.targetId as StarkeepId);
      if (!record) return clientErr("Record not found", 404);
      if (!record.objectStorageKey) return clientErr("Record has no attached file", 422);

      if (record.parentId !== null) {
        return clientErr("Record is already a thumbnail — skipping", 400);
      }

      const thumbnailRecord = await generateThumbnailRecord(
        record,
        resizeForThumbnail,
        { databaseAdapter: db, objectStorageAdapter: storage, clock, ownerId },
      );

      if (!thumbnailRecord) return clientErr("Failed to generate thumbnail", 500);

      return ok({ ok: true, thumbnailId: thumbnailRecord.id });
    }

    return clientErr("Not found", 404);
  } catch (e) {
    console.error("Photos handler error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
