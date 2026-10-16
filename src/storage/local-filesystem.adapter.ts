import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, open, readFile, readdir, rename, unlink, link } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { AppConfig } from '../config/configuration';
import { sha256Hex } from './formats';
import {
  StorageConflictError,
  type StorageAdapter,
  type StorageCapabilities,
  type StorageWriteOptions,
  type StorageWriteResult,
} from './storage-adapter.port';

let tmpCounter = 0;

/**
 * Stage 1 local test adapter: blocks, dictionary, and locks as files under
 * `<directory>/<spaceId>/`. Writes are atomic (tmp + fsync + rename);
 * lock acquisition uses create-exclusive semantics. Space IDs and resource
 * segments are validated so keys can never escape the root.
 */
@Injectable()
export class LocalFilesystemAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    this.root = config.get('persistence', { infer: true }).directory;
  }

  getCapabilities(): StorageCapabilities {
    return { targetBlockBytes: 100 * 1024, conditionalWrites: true };
  }

  async read(spaceId: string, resourceKey: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(spaceId, resourceKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(
    spaceId: string,
    resourceKey: string,
    data: Buffer,
    options: StorageWriteOptions = {},
  ): Promise<StorageWriteResult> {
    const path = this.resolve(spaceId, resourceKey);
    await mkdir(dirname(path), { recursive: true });
    if (options.ifNoneMatch) {
      await this.writeExclusive(path, data, resourceKey);
    } else {
      if (options.ifMatch !== undefined) {
        const current = await this.read(spaceId, resourceKey);
        const etag = current ? sha256Hex(current) : null;
        if (etag !== options.ifMatch) throw new StorageConflictError(resourceKey);
      }
      await this.writeAtomic(path, data);
    }
    return { etag: sha256Hex(data) };
  }

  async delete(spaceId: string, resourceKey: string): Promise<void> {
    try {
      await unlink(this.resolve(spaceId, resourceKey));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async list(spaceId: string, prefix: string): Promise<string[]> {
    this.checkSegment(spaceId);
    const segments = prefix === '' ? [] : prefix.split('/');
    for (const segment of segments) this.checkSegment(segment);
    const base = join(this.root, spaceId, ...segments);
    const out: string[] = [];
    await this.walk(base, base, out);
    return out.sort();
  }

  private async walk(dir: string, base: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await this.walk(full, base, out);
      else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'));
    }
  }

  private resolve(spaceId: string, resourceKey: string): string {
    const segments = [spaceId, ...resourceKey.split('/')];
    for (const segment of segments) this.checkSegment(segment);
    return join(this.root, ...segments);
  }

  private checkSegment(segment: string): void {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(sep) ||
      segment.includes('\\') ||
      segment.includes('\0')
    ) {
      throw new Error(`Refusing to resolve unsafe storage path segment: ${segment}`);
    }
  }

  private async writeAtomic(path: string, data: Buffer): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${(tmpCounter += 1)}`;
    try {
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  private async writeExclusive(path: string, data: Buffer, resourceKey: string): Promise<void> {
    // Hard-link creation is atomic and fails with EEXIST when the target
    // exists — create-exclusive semantics on a single filesystem.
    const tmp = `${path}.tmp-${process.pid}-${(tmpCounter += 1)}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(tmp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new StorageConflictError(resourceKey);
        }
        throw error;
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
}
