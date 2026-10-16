import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BlockLockPort } from '../engine/ports';
import {
  LOCK_FORMAT,
  StorageVersionError,
  newFence,
  parseDictionary,
  parseLock,
  serializeLock,
  type LockFile,
} from './formats';
import {
  STORAGE_ADAPTER,
  StorageConflictError,
  type StorageAdapter,
} from './storage-adapter.port';
import { DictionaryCache } from './dictionary-cache';

/**
 * Pessimistic locks as medium resources (`locks/<resource>`), so every
 * conformant instance sharing the storage can see them. Lock files carry
 * owner, fencing token, and lease expiry; a holder whose lease lapses
 * can never publish over the new holder (fence mismatch).
 *
 * Resources: `dictionary`, `block/<blockId>`. Same-owner re-acquire
 * renews the lease and keeps the fence (lock handoff between this
 * instance's pre-lock and its flush needs no shared owner id when the
 * fence is threaded through — but re-entrancy keeps it robust anyway).
 */
@Injectable()
export class MediumLockService implements BlockLockPort {
  private readonly logger = new Logger(MediumLockService.name);

  constructor(
    @Inject(STORAGE_ADAPTER) private readonly adapter: StorageAdapter,
    private readonly cache: DictionaryCache,
  ) {}

  /** Resolve a key to its current block via the dictionary (cached). */
  async locateKeyBlock(spaceId: string, key: string): Promise<string | null> {
    let cached = this.cache.get(spaceId);
    if (!cached) {
      const raw = await this.adapter.read(spaceId, 'dictionary');
      if (!raw) return null;
      try {
        this.cache.set(spaceId, parseDictionary(raw));
      } catch (error) {
        if (error instanceof StorageVersionError) throw error;
        return null;
      }
      cached = this.cache.get(spaceId);
      if (!cached) return null;
    }
    return cached.dictionary.entries[key]?.blockId ?? null;
  }

  /**
   * Acquire the resource lock. Returns the fencing token, or null when a
   * live lock is held by someone else. Expired or corrupt locks are
   * stolen with a fresh fence.
   */
  async acquire(
    spaceId: string,
    resource: string,
    owner: string,
    leaseMs: number,
  ): Promise<string | null> {
    const key = `locks/${resource}`;
    const now = Date.now();
    let existing: LockFile | null = null;
    try {
      existing = await this.readLock(spaceId, key);
    } catch (error) {
      if (error instanceof StorageVersionError) return null;
      throw error;
    }
    if (existing && existing.leaseExpiresAt > now && existing.owner !== owner) {
      return null;
    }
    if (existing && existing.leaseExpiresAt > now && existing.owner === owner) {
      const renewed: Omit<LockFile, 'checksum'> = { ...existing, leaseExpiresAt: now + leaseMs };
      delete (renewed as { checksum?: string }).checksum;
      await this.adapter.write(spaceId, key, serializeLock(renewed));
      return existing.fence;
    }
    const lock: Omit<LockFile, 'checksum'> = {
      format: LOCK_FORMAT,
      resource,
      owner,
      fence: newFence(),
      leaseExpiresAt: now + leaseMs,
      acquiredAt: now,
    };
    const data = serializeLock(lock);
    if (!existing) {
      try {
        await this.adapter.write(spaceId, key, data, { ifNoneMatch: true });
        return lock.fence;
      } catch (error) {
        if (!(error instanceof StorageConflictError)) throw error;
        // Raced with another creator, or an unreadable file occupies the
        // path: re-read and fall through to the steal path below.
        try {
          existing = await this.readLock(spaceId, key);
        } catch (retryError) {
          if (retryError instanceof StorageVersionError) return null;
          throw retryError;
        }
        if (existing && existing.leaseExpiresAt > now && existing.owner !== owner) {
          return null;
        }
      }
    }
    await this.adapter.write(spaceId, key, data);
    return lock.fence;
  }

  /**
   * Extend the lease. Succeeds only while our fence still matches — a
   * stolen lock is never resurrected, even if it has since expired.
   */
  async renew(
    spaceId: string,
    resource: string,
    owner: string,
    fence: string,
    leaseMs: number,
  ): Promise<boolean> {
    const key = `locks/${resource}`;
    let existing: LockFile | null = null;
    try {
      existing = await this.readLock(spaceId, key);
    } catch (error) {
      if (error instanceof StorageVersionError) return false;
      throw error;
    }
    if (!existing || existing.owner !== owner || existing.fence !== fence) return false;
    const renewed: Omit<LockFile, 'checksum'> = {
      ...existing,
      leaseExpiresAt: Date.now() + leaseMs,
    };
    delete (renewed as { checksum?: string }).checksum;
    await this.adapter.write(spaceId, key, serializeLock(renewed));
    return true;
  }

  /** Release our own lock; never touches another owner's. Best-effort. */
  async releaseResource(spaceId: string, resource: string, owner: string): Promise<void> {
    const key = `locks/${resource}`;
    try {
      const existing = await this.readLock(spaceId, key);
      if (!existing || existing.owner !== owner) return;
      await this.adapter.delete(spaceId, key);
    } catch (error) {
      this.logger.warn(`Failed to release lock ${spaceId}/${key}: ${(error as Error).message}`);
    }
  }

  // ------------------------------------------------------- BlockLockPort
  // Pre-lock surface for the engine: block-scoped views of the above.

  async tryAcquire(
    spaceId: string,
    blockId: string,
    owner: string,
    leaseMs: number,
  ): Promise<string | null> {
    return this.acquire(spaceId, `block/${blockId}`, owner, leaseMs);
  }

  async release(spaceId: string, blockId: string, owner: string): Promise<void> {
    await this.releaseResource(spaceId, `block/${blockId}`, owner);
  }

  private async readLock(spaceId: string, key: string): Promise<LockFile | null> {
    const raw = await this.adapter.read(spaceId, key);
    if (!raw) return null;
    try {
      return parseLock(raw);
    } catch (error) {
      if (error instanceof StorageVersionError) throw error;
      return null;
    }
  }
}
