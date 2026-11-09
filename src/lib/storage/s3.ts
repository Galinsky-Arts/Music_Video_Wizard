import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { attachmentDisposition } from "./disposition";
import type { AssetStorage, PutAssetFileInput, PutAssetInput, StoredAsset } from "./types";

export interface S3AssetStorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3AssetStorage implements AssetStorage {
  private readonly client: S3Client;

  constructor(private readonly options: S3AssetStorageOptions) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint || undefined,
      forcePathStyle: options.forcePathStyle,
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey
            }
          : undefined
    });
  }

  async put(input: PutAssetInput): Promise<StoredAsset> {
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType
      })
    );

    return {
      key: input.key,
      size: input.body.byteLength,
      contentType: input.contentType,
      etag: response.ETag?.replaceAll('"', "")
    };
  }

  async putFile(input: PutAssetFileInput): Promise<StoredAsset> {
    const info = await stat(input.filePath);
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: input.key,
        Body: createReadStream(input.filePath),
        ContentLength: info.size,
        ContentType: input.contentType
      })
    );

    return {
      key: input.key,
      size: info.size,
      contentType: input.contentType,
      etag: response.ETag?.replaceAll('"', "")
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.options.bucket,
        Key: key
      })
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: key
        })
      );
      return true;
    } catch (error) {
      const status =
        typeof error === "object" &&
        error !== null &&
        "$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata
          ? error.$metadata.httpStatusCode
          : undefined;

      if (status === 404) return false;
      throw error;
    }
  }

  async downloadToFile(
    key: string,
    destinationPath: string
  ): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key
      })
    );

    if (!(response.Body instanceof Readable)) {
      throw new Error("S3 asset body is not a Node readable stream.");
    }

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await pipeline(response.Body, createWriteStream(destinationPath, { flags: "wx" }));
  }

  async getSignedReadUrl(
    key: string,
    expiresInSeconds: number,
    downloadFileName?: string
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ResponseContentDisposition: downloadFileName ? attachmentDisposition(downloadFileName) : undefined
      }),
      { expiresIn: expiresInSeconds }
    );
  }
}
