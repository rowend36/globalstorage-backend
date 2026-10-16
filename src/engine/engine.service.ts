import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager, LockMode, raw, type EntityName } from '@mikro-orm/core';
// Type-only: erased at runtime. The injected base EM is a SQL EM at
// runtime; the cast is how we reach the query builder.
import type { SqlEntityManager } from '@mikro-orm/sql';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../storage/storage-adapter.port';
import { DictionaryCache } from '../storage/dictionary-cache';
import {
  StorageVersionError,
  parseBlock,
  parseDictionary,
} from '../storage/formats';
import {
  SpaceKeySchema,
  SpaceSchema,
  type Space,
} from '../database/entities';
import type { AppConfig } from '../config/configuration';
import {
  KeyVersionConflictException,
  QuotaExceededException,
} from './engine.errors';
import { validateKeyName, validateSpaceName } from './key-utils';
import { FlushScheduler } from './flush-scheduler';
import { BLOCK_LOCKS, type BlockLockPort } from './ports';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const DIRTY_LIST_LIMIT = 1000;
/** Pre-lock leases must cover the debounce window plus the flush apply. */
const PRE_LOCK_LEASE_MS = 60_000;

export interface SpaceSummary {
  id: string;
  name: string;
  quotaBytes: number;
  usedBytes: number;
  state: string;
  providerType: string;
  providerConfig: Record<string, unknown> | null;
}

export interface WriteKeyInput {
  ownerId: string;
  spaceId: string;
  key: string;
  value: Buffer;
  contentType?: string | null;
  /**
   * Optimistic-concurrency precondition: undefined = unconditional,
   * null = create-only (key must not exist), number = current live
   * version must equal this timestamp.
   */
  expectedVersion?: number | null;
}

export interface WriteKeyResult {
  key: string;
  version: number;
  sizeBytes: number;
  spaceUsedBytes: number;
  spaceQuotaBytes: number;
}

export interface ReadKeyResult {
  value: Buffer;
  contentType: string | null;
  version: number;
  updatedAt: Date | null;
}

export interface DeleteKeyResult {
  key: string;
  version: number;
}

export interface KeySummary {
  key: string;
  version: number;
  contentType: string | null;
  sizeBytes: number;
  updatedAt: Date | null;
  status: 'pending' | 'persisted';
}

export interface ListKeysResult {
  keys: KeySummary[];
  nextCursor: string | null;
}

export interface SpaceStatus {
  spaceId: string;
  name: string;
  state: string;
  quotaBytes: number;
  usedBytes: number;
  keyCount: number;
  pendingKeys: number;
  pendingBytes: number;
}

export interface DirtyKey {
  id: string;
  key: string;
  version: number;
  value: Buffer;
  contentType: string | null;
  deleted: boolean;
}

export interface KeyVersionInfo {
  key: string;
  version: number;
  deleted: boolean;
}

export interface MediumEntry {
  value: Buffer;
  version: number;
  contentType: string | null;
}

interface PreLock {
  fence: string;
  acquiredAt: number;
}

/**
 * The operational key-value engine. Reads and writes touch only the
 * `spaces` / `space_keys` tables — never blocks, dictionaries, or the
 * storage medium. Versions are timestamps (recency ordering); deletes
 * are tombstone rows purged after the flush confirms medium removal.
 *
 * Space state (`active`/`unhealthy`) is surfaced but never blocks local
 * reads or writes: the operational database accepts writes independently
 * of provider health. The flush worker (Phase 3) refuses to push for
 * unhealthy spaces and fails explicitly.
 */
@Injectable()
export class StorageEngineService {
  private readonly instanceId = randomUUID();
  private readonly preLocks = new Map<string, Map<string, PreLock>>();

  constructor(
    private readonly em: EntityManager,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly scheduler: FlushScheduler,
    @Optional() @Inject(BLOCK_LOCKS) private readonly locks?: BlockLockPort,
    @Optional() @Inject(STORAGE_ADAPTER) private readonly storage?: StorageAdapter,
    @Optional() private readonly dictionaryCache?: DictionaryCache,
  ) {}

  // ---------------------------------------------------------------- spaces

  async createSpace(ownerId: string, name: string, quotaBytes?: number): Promise<SpaceSummary> {
    const cleanName = validateSpaceName(name);
    const { defaultQuotaBytes, aggregateQuotaBytes } = this.config.get('spaces', {
      infer: true,
    });
    const quota = quotaBytes ?? defaultQuotaBytes;
    if (!Number.isInteger(quota) || quota <= 0) {
      throw new BadRequestException('Space quota must be a positive integer');
    }
    if (quota > aggregateQuotaBytes) {
      throw new BadRequestException('Space quota cannot exceed the aggregate storage limit');
    }
    const space = this.em.create(SpaceSchema, {
      owner: ownerId,
      name: cleanName,
      quotaBytes: quota,
      usedBytes: 0,
      providerConfig: null,
      state: 'active',
    });
    await this.em.flush();
    return this.toSpaceSummary(space);
  }

  async updateSpace(
    ownerId: string,
    spaceId: string,
    patch: { name?: string; quotaBytes?: number },
  ): Promise<SpaceSummary> {
    const { aggregateQuotaBytes } = this.config.get('spaces', { infer: true });
    return this.em.transactional(async (tx) => {
      const space = await this.loadSpaceForUpdate(tx, ownerId, spaceId);
      if (patch.name !== undefined) space.name = validateSpaceName(patch.name);
      if (patch.quotaBytes !== undefined) {
        if (!Number.isInteger(patch.quotaBytes) || patch.quotaBytes <= 0) {
          throw new BadRequestException('Space quota must be a positive integer');
        }
        if (patch.quotaBytes > aggregateQuotaBytes) {
          throw new BadRequestException(
            'Space quota cannot exceed the aggregate storage limit',
          );
        }
        if (patch.quotaBytes < space.usedBytes) {
          throw new BadRequestException('Space quota cannot be set below current usage');
        }
        space.quotaBytes = patch.quotaBytes;
      }
      await tx.flush();
      return this.toSpaceSummary(space);
    });
  }

  async deleteSpace(ownerId: string, spaceId: string): Promise<{ id: string }> {
    await this.em.transactional(async (tx) => {
      const space = await this.loadSpaceForUpdate(tx, ownerId, spaceId);
      await tx.nativeDelete(SpaceKeySchema, { space: space.id });
      tx.remove(space);
      await tx.flush();
    });
    // Medium-side prefix wipe is the flush worker's job (Phase 3, under
    // the dict lock). Cancel any pending flush for the deleted space.
    this.scheduler.cancel(spaceId);
    return { id: spaceId };
  }

  /** Internal state transition for the flush worker (Phase 3). */
  async setSpaceState(spaceId: string, state: 'active' | 'unhealthy'): Promise<void> {
    await this.em.nativeUpdate(SpaceSchema, { id: spaceId }, { state });
  }

  /** Space-scoped lookup for the flush worker (null when rows are gone). */
  async getSpace(spaceId: string): Promise<SpaceSummary | null> {
    const space = await this.em.findOne(SpaceSchema, { id: spaceId });
    return space ? this.toSpaceSummary(space) : null;
  }

  // ------------------------------------------------------------------ keys

  async writeKey(input: WriteKeyInput): Promise<WriteKeyResult> {
    const key = validateKeyName(input.key);
    const { aggregateQuotaBytes, maxKeyBytes } = this.config.get('spaces', { infer: true });
    if (input.value.length > maxKeyBytes) {
      throw new PayloadTooLargeException('Value exceeds the maximum key size');
    }
    const result = await this.em.transactional(async (tx) => {
      const space = await this.loadSpaceForUpdate(tx, input.ownerId, input.spaceId);
      const existing = await tx.findOne(SpaceKeySchema, { space: space.id, key });
      const live = existing && !existing.deletedAt ? existing : null;
      if (input.expectedVersion === null && live) {
        throw new KeyVersionConflictException(live.version);
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
        if (!live || live.version !== input.expectedVersion) {
          throw new KeyVersionConflictException(live?.version ?? null);
        }
      }
      const newVersion = Math.max(Date.now(), (existing?.version ?? 0) + 1);
      const oldBytes = live ? live.value.length : 0;
      const delta = input.value.length - oldBytes;
      await this.checkQuota(tx, input.ownerId, space, aggregateQuotaBytes, delta);
      if (existing) {
        existing.value = input.value;
        existing.contentType = input.contentType ?? null;
        existing.version = newVersion;
        existing.deletedAt = null;
      } else {
        tx.create(SpaceKeySchema, {
          space: space.id,
          key,
          version: newVersion,
          value: input.value,
          contentType: input.contentType ?? null,
          lastPersistedVersion: 0,
          deletedAt: null,
        });
      }
      space.usedBytes += delta;
      await tx.flush();
      return {
        key,
        version: newVersion,
        sizeBytes: input.value.length,
        spaceUsedBytes: space.usedBytes,
        spaceQuotaBytes: space.quotaBytes,
      };
    });
    this.scheduler.schedule(input.spaceId);
    await this.tryPreLock(input.spaceId, key);
    return result;
  }

  async readKey(input: {
    ownerId: string;
    spaceId: string;
    key: string;
  }): Promise<ReadKeyResult> {
    const space = await this.loadSpace(input.ownerId, input.spaceId);
    const row = await this.em.findOne(SpaceKeySchema, { space: space.id, key: input.key });
    if (row && !row.deletedAt) {
      // A present row is always authoritative for reads.
      return {
        value: Buffer.from(row.value),
        contentType: row.contentType ?? null,
        version: row.version,
        updatedAt: row.updatedAt ?? null,
      };
    }
    // Tombstones read as deleted without consulting the medium
    // (read-your-deletes); the flush reconciles concurrent medium writes.
    if (row) throw new NotFoundException('Key not found');
    if (!this.storage || !this.dictionaryCache) throw new NotFoundException('Key not found');
    return this.hydrateFromMedium(space.id, input.key);
  }

  /**
   * Read-miss hydration: the key is absent locally but may live on the
   * medium (another instance wrote it, or our rows were rebuilt). Pulls
   * the envelope into a persisted row. Genuine 404 only when the key is
   * in neither place; anything inconsistent fails explicitly (503).
   */
  private async hydrateFromMedium(spaceId: string, key: string): Promise<ReadKeyResult> {
    const storage = this.storage;
    const cache = this.dictionaryCache;
    if (!storage || !cache) throw new NotFoundException('Key not found');
    let cached = cache.get(spaceId);
    if (!cached) {
      const rawDictionary = await storage.read(spaceId, 'dictionary');
      if (!rawDictionary) throw new NotFoundException('Key not found');
      try {
        cache.set(spaceId, parseDictionary(rawDictionary));
      } catch (error) {
        if (error instanceof StorageVersionError) {
          await this.setSpaceState(spaceId, 'unhealthy');
          throw new ServiceUnavailableException('Stored data uses a newer format version');
        }
        throw new NotFoundException('Key not found');
      }
      cached = cache.get(spaceId);
      if (!cached) throw new NotFoundException('Key not found');
    }
    const entry = cached.dictionary.entries[key];
    if (!entry) throw new NotFoundException('Key not found');
    const blockRaw = await storage.read(spaceId, `blocks/${entry.blockId}`);
    if (!blockRaw) throw new ServiceUnavailableException('Key data unavailable');
    let envelope;
    try {
      envelope = parseBlock(blockRaw).entries[key];
    } catch (error) {
      if (error instanceof StorageVersionError) {
        await this.setSpaceState(spaceId, 'unhealthy');
        throw new ServiceUnavailableException('Stored data uses a newer format version');
      }
      throw new ServiceUnavailableException('Key data unavailable');
    }
    if (!envelope || envelope.keyVersion !== entry.keyVersion) {
      throw new ServiceUnavailableException('Key data unavailable');
    }
    const pulled = {
      value: Buffer.from(envelope.value, 'base64'),
      version: envelope.keyVersion,
      contentType: envelope.contentType,
    };
    const { applied } = await this.upsertFromMedium(spaceId, key, pulled);
    if (!applied) {
      // A concurrent local write landed meanwhile; serve the newer row.
      const current = await this.em.findOne(SpaceKeySchema, { space: spaceId, key });
      if (!current || current.deletedAt) throw new NotFoundException('Key not found');
      return {
        value: Buffer.from(current.value),
        contentType: current.contentType ?? null,
        version: current.version,
        updatedAt: current.updatedAt ?? null,
      };
    }
    return {
      value: pulled.value,
      contentType: pulled.contentType,
      version: pulled.version,
      updatedAt: new Date(pulled.version),
    };
  }

  async deleteKey(input: {
    ownerId: string;
    spaceId: string;
    key: string;
  }): Promise<DeleteKeyResult> {
    const key = validateKeyName(input.key);
    const result = await this.em.transactional(async (tx) => {
      const space = await this.loadSpaceForUpdate(tx, input.ownerId, input.spaceId);
      const row = await tx.findOne(SpaceKeySchema, { space: space.id, key });
      if (!row || row.deletedAt) throw new NotFoundException('Key not found');
      const deletedVersion = Math.max(Date.now(), row.version + 1);
      space.usedBytes -= row.value.length;
      row.value = Buffer.alloc(0);
      row.contentType = null;
      row.version = deletedVersion;
      row.deletedAt = new Date();
      await tx.flush();
      return { key, version: deletedVersion };
    });
    this.scheduler.schedule(input.spaceId);
    await this.tryPreLock(input.spaceId, key);
    return result;
  }

  async listKeys(input: {
    ownerId: string;
    spaceId: string;
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ListKeysResult> {
    const space = await this.loadSpace(input.ownerId, input.spaceId);
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const collected: KeySummary[] = [];
    let cursor: string | undefined = input.cursor;
    for (;;) {
      const where: Record<string, unknown> = { space: space.id, deletedAt: null };
      if (cursor) where.key = { $gt: cursor };
      const batch = await this.em.find(SpaceKeySchema, where, {
        orderBy: { key: 'ASC' },
        limit: limit + 1,
      });
      if (batch.length === 0) break;
      for (const row of batch) {
        if (!input.prefix || row.key.startsWith(input.prefix)) {
          collected.push({
            key: row.key,
            version: row.version,
            contentType: row.contentType ?? null,
            sizeBytes: row.value.length,
            updatedAt: row.updatedAt ?? null,
            status: row.version > row.lastPersistedVersion ? 'pending' : 'persisted',
          });
        }
        if (collected.length === limit + 1) break;
      }
      cursor = batch[batch.length - 1].key;
      if (collected.length === limit + 1 || batch.length < limit + 1) break;
    }
    const page = collected.slice(0, limit);
    return {
      keys: page,
      nextCursor: collected.length > limit && page.length > 0 ? page[page.length - 1].key : null,
    };
  }

  async getStatus(ownerId: string, spaceId: string): Promise<SpaceStatus> {
    const space = await this.loadSpace(ownerId, spaceId);
    const [keyCount, pending] = await Promise.all([
      this.em.count(SpaceKeySchema, { space: space.id, deletedAt: null }),
      this.sql(this.em, SpaceKeySchema)
        .select([raw('count(*) as keys'), raw('coalesce(sum(length(value)), 0) as bytes')])
        .where({ space: space.id })
        .andWhere('version > last_persisted_version')
        .execute('all') as Promise<Array<{ keys: number | string; bytes: number | string }>>,
    ]);
    const row = pending[0];
    return {
      spaceId: space.id,
      name: space.name,
      state: space.state,
      quotaBytes: space.quotaBytes,
      usedBytes: space.usedBytes,
      keyCount,
      pendingKeys: Number(row?.keys ?? 0),
      pendingBytes: Number(row?.bytes ?? 0),
    };
  }

  // ------------------------------------------------- flush-worker toolkit
  // Internal primitives for the Phase 3 flush worker. Space-scoped (no
  // owner check): only our own worker calls these, never the API layer.

  async listDirtyKeys(spaceId: string, limit = DIRTY_LIST_LIMIT): Promise<DirtyKey[]> {
    const rows = (await this.sql(this.em, SpaceKeySchema, 'k')
      .select(['k.id', 'k.key', 'k.version', 'k.value', 'k.contentType', 'k.deletedAt'])
      .where({ space: spaceId })
      .andWhere('version > last_persisted_version')
      .orderBy({ key: 'ASC' })
      .limit(limit)
      .execute('all')) as Array<{
      id: string;
      key: string;
      version: number | string;
      value: Buffer;
      contentType: string | null;
      deletedAt: unknown;
    }>;
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      version: Number(row.version),
      value: Buffer.from(row.value),
      contentType: row.contentType,
      deleted: row.deletedAt != null,
    }));
  }

  async listKeyVersions(spaceId: string): Promise<KeyVersionInfo[]> {
    const rows = (await this.sql(this.em, SpaceKeySchema, 'k')
      .select(['k.key', 'k.version', 'k.deletedAt'])
      .where({ space: spaceId })
      .execute('all')) as Array<{ key: string; version: number | string; deletedAt: unknown }>;
    return rows.map((row) => ({
      key: row.key,
      version: Number(row.version),
      deleted: row.deletedAt != null,
    }));
  }

  /** Live rows for a key set (missing-block rebuild input). Chunked. */
  async getKeyEntries(
    spaceId: string,
    keys: string[],
  ): Promise<Array<{ key: string; value: Buffer; version: number; contentType: string | null }>> {
    const out: Array<{ key: string; value: Buffer; version: number; contentType: string | null }> = [];
    for (let index = 0; index < keys.length; index += 500) {
      const batch = keys.slice(index, index + 500);
      if (batch.length === 0) continue;
      const rows = await this.em.find(SpaceKeySchema, {
        space: spaceId,
        key: { $in: batch },
        deletedAt: null,
      });
      for (const row of rows) {
        out.push({
          key: row.key,
          value: Buffer.from(row.value),
          version: row.version,
          contentType: row.contentType ?? null,
        });
      }
    }
    return out;
  }

  /**
   * Medium state unknown (no dictionary file): void every persisted
   * claim so the full local state is pushed and confirmed again.
   * Idempotent and exact — dirty rows stay dirty.
   */
  async requeueSpace(spaceId: string): Promise<number> {
    return this.em.nativeUpdate(SpaceKeySchema, { space: spaceId }, { lastPersistedVersion: 0 });
  }

  async markKeyPersisted(keyId: string, version: number): Promise<boolean> {
    const updated = await this.em.nativeUpdate(
      SpaceKeySchema,
      { id: keyId, version },
      { lastPersistedVersion: version },
    );
    return updated > 0;
  }

  async purgeTombstone(keyId: string): Promise<boolean> {
    const deleted = await this.em.nativeDelete(SpaceKeySchema, {
      id: keyId,
      deletedAt: { $ne: null },
    });
    return deleted > 0;
  }

  async upsertFromMedium(
    spaceId: string,
    key: string,
    entry: MediumEntry,
  ): Promise<{ applied: boolean }> {
    // Pulled data was quota-checked when originally committed elsewhere;
    // re-checking could spuriously reject coherent state, so only the
    // accounting is adjusted.
    return this.em.transactional(async (tx) => {
      const space = await tx.findOneOrFail(SpaceSchema, { id: spaceId });
      const existing = await tx.findOne(SpaceKeySchema, { space: space.id, key });
      if (existing && existing.version >= entry.version) return { applied: false };
      const oldBytes = existing && !existing.deletedAt ? existing.value.length : 0;
      if (existing) {
        existing.value = entry.value;
        existing.contentType = entry.contentType;
        existing.version = entry.version;
        existing.deletedAt = null;
        existing.lastPersistedVersion = entry.version;
      } else {
        tx.create(SpaceKeySchema, {
          space: space.id,
          key,
          version: entry.version,
          value: entry.value,
          contentType: entry.contentType,
          lastPersistedVersion: entry.version,
          deletedAt: null,
        });
      }
      space.usedBytes += entry.value.length - oldBytes;
      await tx.flush();
      return { applied: true };
    });
  }

  /**
   * Gap-1 rule: a clean local row absent from the medium dictionary was
   * deleted elsewhere — remove it. Dirty rows are left for the push;
   * tombstones are purged (their deletion already reached the medium).
   */
  async deleteLocalRow(spaceId: string, key: string): Promise<boolean> {
    const space = await this.em.findOne(SpaceSchema, { id: spaceId });
    if (!space) return false;
    const row = await this.em.findOne(SpaceKeySchema, { space: space.id, key });
    if (!row) return false;
    if (row.deletedAt) {
      await this.em.remove(row).flush();
      return true;
    }
    if (row.version !== row.lastPersistedVersion) return false;
    space.usedBytes -= row.value.length;
    await this.em.remove(row).flush();
    return true;
  }

  /** Hand held pre-locks to the flush worker (clears the registry). */
  consumePreLocks(
    spaceId: string,
  ): Array<{ blockId: string; fence: string; owner: string; acquiredAt: number }> {
    const held = this.preLocks.get(spaceId);
    this.preLocks.delete(spaceId);
    if (!held) return [];
    return [...held.entries()].map(([blockId, lock]) => ({
      blockId,
      owner: this.instanceId,
      ...lock,
    }));
  }

  // ---------------------------------------------------------------- helpers

  /**
   * QueryBuilder bound to this EM — transaction-aware when given a
   * transactional EM. Aggregates and column-to-column predicates are
   * expressed as string/embedded-raw fragments: object-where syntax
   * cannot represent `SUM()` or `version > last_persisted_version`.
   */
  private sql<T extends object>(em: EntityManager, entity: EntityName<T>, alias?: string) {
    return (em as SqlEntityManager).createQueryBuilder(entity, alias);
  }

  private toSpaceSummary(space: Space): SpaceSummary {
    return {
      id: space.id,
      name: space.name,
      quotaBytes: space.quotaBytes,
      usedBytes: space.usedBytes,
      state: space.state,
      providerType: space.providerType,
      providerConfig: (space.providerConfig ?? null) as Record<string, unknown> | null,
    };
  }

  private async loadSpace(ownerId: string, spaceId: string): Promise<Space> {
    const space = await this.em.findOne(SpaceSchema, { id: spaceId, owner: ownerId });
    if (!space) throw new NotFoundException('Space not found');
    return space;
  }

  private async loadSpaceForUpdate(
    tx: EntityManager,
    ownerId: string,
    spaceId: string,
  ): Promise<Space> {
    // Row lock serializes writers per space so quota checks are exact.
    // (Single-writer sqlite serializes regardless; pg uses FOR UPDATE.
    // Cross-space aggregate races remain possible — see checkQuota.)
    const space = await tx.findOne(
      SpaceSchema,
      { id: spaceId, owner: ownerId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (!space) throw new NotFoundException('Space not found');
    return space;
  }

  private async checkQuota(
    tx: EntityManager,
    ownerId: string,
    space: Space,
    aggregateQuotaBytes: number,
    delta: number,
  ): Promise<void> {
    if (delta <= 0) return;
    if (space.usedBytes + delta > space.quotaBytes) {
      throw new QuotaExceededException('space');
    }
    // Aggregate caps usage, not the sum of per-space quotas. Checked
    // inside the transaction; concurrent writes across *different* spaces
    // can still transiently overshoot — accepted residual for Stage 1.
    const row = (await this.sql(tx, SpaceSchema)
      .select([raw('coalesce(sum(used_bytes), 0) as total')])
      .where({ owner: ownerId })
      .execute('get')) as { total: number | string } | undefined;
    if (Number(row?.total ?? 0) + delta > aggregateQuotaBytes) {
      throw new QuotaExceededException('aggregate');
    }
  }

  private async tryPreLock(spaceId: string, key: string): Promise<void> {
    if (!this.locks) return;
    try {
      const blockId = await this.locks.locateKeyBlock(spaceId, key);
      if (!blockId) return;
      const fence = await this.locks.tryAcquire(
        spaceId,
        blockId,
        this.instanceId,
        PRE_LOCK_LEASE_MS,
      );
      if (!fence) return;
      let held = this.preLocks.get(spaceId);
      if (!held) {
        held = new Map();
        this.preLocks.set(spaceId, held);
      }
      held.set(blockId, { fence, acquiredAt: Date.now() });
    } catch {
      // Best-effort: the flush retries the same sequence under its own
      // locking. A failed pre-lock must never fail the write.
    }
  }
}
