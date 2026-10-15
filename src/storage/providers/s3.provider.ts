import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig } from '../../config/configuration';
import type {
  StorageObject,
  StoragePort,
  StorageUrlOptions,
  StorageValidationOptions,
} from '../storage.port';

@Injectable()
export class S3StorageProvider implements StoragePort {
  private client?: S3Client;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async put(
    key: string,
    content: Uint8Array,
    contentType: string,
  ): Promise<StorageObject> {
    this.validateContent(content, contentType);
    const bucket = this.bucket();
    await this.clientForRegion().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
      }),
    );
    return {
      key,
      content,
      contentType,
      size: content.byteLength,
    };
  }

  async read(key: string): Promise<StorageObject> {
    try {
      const response = await this.clientForRegion().send(
        new GetObjectCommand({ Bucket: this.bucket(), Key: key }),
      );
      if (!response.Body) throw new NotFoundException('Storage object not found');
      const content = await response.Body.transformToByteArray();
      return {
        key,
        content,
        contentType: response.ContentType,
        size: response.ContentLength ?? content.byteLength,
        etag: response.ETag,
        lastModified: response.LastModified,
      };
    } catch (error) {
      if (this.isNotFound(error)) throw new NotFoundException('Storage object not found');
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.clientForRegion().send(
      new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }),
    );
  }

  async getUrl(key: string, options: StorageUrlOptions = {}): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ...(options.downloadName
        ? { ResponseContentDisposition: `attachment; filename="${options.downloadName}"` }
        : {}),
    });
    return getSignedUrl(this.clientForRegion(), command, {
      expiresIn: options.expiresInSeconds ?? 900,
    });
  }

  validateContent(
    content: Uint8Array,
    contentType: string,
    options: StorageValidationOptions = {},
  ): void {
    if (options.maxBytes !== undefined && content.byteLength > options.maxBytes) {
      throw new Error(`Storage object exceeds the ${options.maxBytes}-byte limit`);
    }
    if (
      options.allowedContentTypes?.length &&
      !options.allowedContentTypes.includes(contentType)
    ) {
      throw new Error(`Content type is not allowed: ${contentType}`);
    }
  }

  private bucket(): string {
    const bucket = this.config.get('storage.bucket', { infer: true });
    if (!bucket) throw new Error('S3_BUCKET is required for the S3 storage provider');
    return bucket;
  }

  private clientForRegion(): S3Client {
    const region = this.config.get('storage.region', { infer: true });
    if (!region) throw new Error('S3_REGION is required for the S3 storage provider');
    return (this.client ??= new S3Client({ region }));
  }

  private isNotFound(error: unknown): boolean {
    return (
      error instanceof Error &&
      ['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(
        (error as Error & { name?: string }).name ?? '',
      )
    );
  }
}
