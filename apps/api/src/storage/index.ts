import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config";

/**
 * Private object storage. Objects are only ever read back through the API;
 * provider URLs are never handed to the client.
 */
export interface BlobStorage {
  putBlob(key: string, body: Buffer, contentType: string): Promise<void>;
  getBlob(key: string): Promise<Buffer | null>;
  deleteBlob(key: string): Promise<void>;
}

/** S3-compatible adapter (Cloudflare R2, or any S3 API). */
export function createS3Storage(config: Config): BlobStorage {
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
    forcePathStyle: true,
  });
  const Bucket = config.S3_BUCKET;
  return {
    async putBlob(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async getBlob(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) return null;
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name === "NoSuchKey" || name === "NotFound") return null;
        throw err;
      }
    },
    async deleteBlob(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

/** In-memory adapter for tests. */
export function createMemoryStorage(): BlobStorage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async putBlob(key, body) { objects.set(key, Buffer.from(body)); },
    async getBlob(key) { return objects.get(key) ?? null; },
    async deleteBlob(key) { objects.delete(key); },
  };
}
