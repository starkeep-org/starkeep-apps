/**
 * Photos Lambda handler — server-side thumbnail generation for the photos app.
 *
 * POST /data/generate-thumbnail: fetches a source image from S3, runs sharp to
 * produce a thumbnail, creates a new DataRecord for the thumbnail (with
 * content.parentId pointing to the original), and stores the record in DSQL.
 *
 * Environment variables (injected by SST):
 *   AURORA_ENDPOINT  — Aurora DSQL cluster hostname
 *   S3_BUCKET        — S3 bucket name for object storage
 *   AWS_REGION       — set automatically by Lambda runtime
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
import { ok, clientErr, type APIGatewayEvent } from "./handler-utils.js";

// ---------------------------------------------------------------------------
// DSQL client factory using the Lambda execution role credentials
// ---------------------------------------------------------------------------

class LambdaDsqlClientFactory implements DatabaseClientFactory {
  async createClient(options: AuroraDsqlDatabaseAdapterOptions): Promise<DatabaseClient> {
    const { hostname, region } = options;

    const createPgClient = async (): Promise<pg.Client> => {
      const signer = new DsqlSigner({ hostname, region });
      const token = await signer.getDbConnectAdminAuthToken();
      const client = new pg.Client({
        host: hostname,
        port: 5432,
        database: options.database ?? "postgres",
        user: "admin",
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
  const auroraEndpoint = process.env.AURORA_ENDPOINT;
  const s3Bucket = process.env.S3_BUCKET;

  if (!auroraEndpoint) throw new Error("AURORA_ENDPOINT env var is required");
  if (!s3Bucket) throw new Error("S3_BUCKET env var is required");

  const db = new AuroraDsqlDatabaseAdapter(
    { hostname: auroraEndpoint, region },
    new LambdaDsqlClientFactory(),
  );
  await db.init();

  const storage = new S3ObjectStorageAdapter({ bucketName: s3Bucket, region });
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

      // Only generate thumbnails for originals (parentId === "")
      const parentId = (record.content as { parentId?: string }).parentId ?? "";
      if (parentId !== "") {
        return clientErr("Record is already a thumbnail — skipping", 400);
      }

      const { default: sharp } = await import("sharp") as { default: typeof import("sharp") };

      const thumbnailRecord = await generateThumbnailRecord(
        record,
        async (imageBytes, maxWidth) => {
          const inputBuffer = Buffer.from(imageBytes);
          const meta = await sharp(inputBuffer).metadata();
          const hasAlpha = meta.hasAlpha ?? false;

          const resized = await sharp(inputBuffer)
            .rotate()
            .resize(maxWidth, maxWidth, {
              fit: "inside",
              kernel: "cubic",
              withoutEnlargement: true,
            })
            [hasAlpha ? "webp" : "jpeg"](hasAlpha ? { quality: 76 } : { quality: 85 })
            .toBuffer();

          const outputMeta = await sharp(resized).metadata();
          return {
            data: new Uint8Array(resized),
            width: outputMeta.width ?? 0,
            height: outputMeta.height ?? 0,
          };
        },
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
