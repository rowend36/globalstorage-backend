import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { isAbsolute, relative as relativePath, resolve } from 'path';
import { AppConfig } from '../../config/configuration';
import type {
  StorageObject,
  StoragePort,
  StorageUrlOptions,
  StorageValidationOptions,
} from '../storage.port';

@Injectable()
export class FilesystemStorageProvider implements StoragePort {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async put(
    key: string,
    content: Uint8Array,
    contentType: string,
  ): Promise<StorageObject> {
    this.validateContent(content, contentType);
    const file = this.filePath(key);
    await mkdir(resolve(file, '..'), { recursive: true });
    await writeFile(file, content);
    return this.object(key, content, contentType);
  }

  async read(key: string): Promise<StorageObject> {
    const file = this.filePath(key);
    try {
      const [content, details] = await Promise.all([readFile(file), stat(file)]);
      return this.object(key, content, undefined, details.mtime);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Storage object not found');
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.filePath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async getUrl(key: string, options: StorageUrlOptions = {}): Promise<string> {
    this.filePath(key);
    const base = this.config.get('storage.publicUrl', { infer: true });
    if (!base) throw new Error('STORAGE_PUBLIC_URL is required for filesystem links');
    const url = new URL(`${base.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`);
    if (options.downloadName) url.searchParams.set('download', options.downloadName);
    return url.href;
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

  private filePath(key: string): string {
    const directory = this.config.get('storage.directory', { infer: true });
    const root = resolve(directory);
    const file = resolve(root, key);
    const relative = relativePath(root, file);
    const sep = process.platform === 'win32' ? '\\' : '/';
    if (
      !key ||
      isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${sep}`)
    ) {
      throw new Error('Invalid storage key');
    }
    return file;
  }

  private object(
    key: string,
    content: Uint8Array,
    contentType: string | undefined,
    lastModified?: Date,
  ): StorageObject {
    return {
      key,
      content,
      contentType,
      size: content.byteLength,
      etag: createHash('sha256').update(content).digest('hex'),
      lastModified,
    };
  }
}
