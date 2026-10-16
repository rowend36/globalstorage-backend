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
  type LockStrategy,
  type StorageAdapter,
} from '../storage_adapters/storage-adapter.port';
import { DictionaryCache } from '../storage_adapters/dictionary-cache';
import {
  StorageVersionError,
  parseBlock,
  parseDictionary,
  type BlockFile,
} from '../storage_adapters/formats';
import { needsRenew } from '../storage_adapters/medium-locks';
import {
  SpaceKeySchema,
  SpaceSchema,
  type Space,
} from '../database/entities';
import type { AppConfig } from '../config/configuration';
import { INSTANCE_ID } from './instance';
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
/** Block pre-lock lease: must cover write→flush adoption; adoption converts. */
const PRE_LOCK_LEASE_MS = 60_000;
/**
 * Dict-lock lease for pre-lock/read sequences: covers one
 * resolve-and-acquire round with margin. Short on purpose — dict
 * exclusion is space-global, so lapse (not explicit release) bounds it.
 */
const PRELOCK_DICT_LEASE_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  });

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
   * version must equal this timestamp, 'exists' = key must exist
   * (update-only, any version).
   */
  expectedVersion?: number | null | 'exists';
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
 * Shared block-read outcome: a parsed file (lock retained for the
 * caller), an unavailable block (busy/corrupt/missing — retryable), or
 * a terminal version conflict (fail explicit, no retry).
 */
type SharedBlockRead =
  | { status: 'ready'; blockId: string; fence: string; file: BlockFile }
  | { status: 'busy' }
  | { status: 'missing' }
  | { status: 'terminal' };

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
  private readonly instanceId = INSTANCE_ID;
  private readonly preLocks = new Map<string, Map<string, PreLock>>();
  private readonly strategyCache = new Map<string, LockStrategy>();
  private readonly dictAcquiring = new Map<string, Promise<string | null>>();
  /** Dict-lock coverage per space (short-circuit re-acquisition while valid). */
  private readonly dictHeldUntil = new Map<string, number>();
  /**
   * Spaces with a fresh (never reconciled-since) block hold. Serve-direct
   * stays off for these — a lapse gap may have seen unseen publishes.
   * Cleared by the worker after each successful reconcile.
   */
  private readonly needsResync = new Set<string>();
  /** In-flight block reads, shared by attached readers and background refresh. */
  private readonly inflightReads = new Map<string, Promise<SharedBlockRead>>();
  /** Running background refresh loops, singleflighted per block. */
  private readonly bgRefreshInFlight = new Map<string, Promise<void>>();

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
    const summary = await this.em.transactional(async (tx) => {
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
    // providerConfig is immutable via this endpoint today, but drop any
    // cached strategy regardless so future patches cannot go stale.
    this.strategyCache.delete(spaceId);
    return summary;
  }

  async deleteSpace(ownerId: string, spaceId: string): Promise<{ id: string }> {
    await this.em.transactional(async (tx) => {
      const space = await this.loadSpaceForUpdate(tx, ownerId, spaceId);
      await tx.nativeDelete(SpaceKeySchema, { space: space.id });
      tx.remove(space);
      await tx.flush();
    });
    // Medium-side prefix wipe is the flush worker's job (under the dict
    // lock). Cancel any pending flush and drop local per-space state.
    this.scheduler.cancel(spaceId);
    this.preLocks.delete(spaceId);
    this.strategyCache.delete(spaceId);
    this.needsResync.delete(spaceId);
    this.dictHeldUntil.delete(spaceId);
    return { id: spaceId };
  }

  /** Lock acquisition discipline per space (cached; safe default). */
  async strategyFor(spaceId: string): Promise<LockStrategy> {
    const cached = this.strategyCache.get(spaceId);
    if (cached) return cached;
    let strategy: LockStrategy = this.storage?.getCapabilities().lockStrategy ?? 'pessimistic';
    try {
      const space = await this.em.findOne(SpaceSchema, { id: spaceId });
      const override = (space?.providerConfig as { lockStrategy?: unknown } | null)?.lockStrategy;
      if (override === 'pessimistic' || override === 'optimistic') strategy = override;
    } catch {
      // Fall through with the safest default; the flush verifies anyway.
    }
    this.strategyCache.set(spaceId, strategy);
    return strategy;
  }

  /** Cleared by the worker after each successful reconcile. */
  clearNeedsResync(spaceId: string): void {
    this.needsResync.delete(spaceId);
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

  async getSpaceSummary(ownerId: string, spaceId: string): Promise<SpaceSummary> {
    return this.toSpaceSummary(await this.loadSpace(ownerId, spaceId));
  }

  async listSpaces(ownerId: string): Promise<SpaceSummary[]> {
    const rows = await this.em.find(
      SpaceSchema,
      { owner: ownerId },
      { orderBy: { createdAt: 'ASC' } },
    );
    return rows.map((space) => this.toSpaceSummary(space));
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
      if (input.expectedVersion === 'exists' && !live) {
        throw new KeyVersionConflictException(null);
      }
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== null &&
        input.expectedVersion !== 'exists'
      ) {
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
      const direct = this.serveDirect(space.id, row);
      if (direct) return direct;
      if (!this.storage || !this.dictionaryCache) {
        // No medium layer wired: the row is all we know (Phase-2 behavior).
        return this.toReadResult(row);
      }
      return this.consultMedium(space.id, row);
    }
    // Tombstones read as deleted without consulting the medium
    // (read-your-deletes); the flush reconciles concurrent medium writes.
    if (row) throw new NotFoundException('Key not found');
    if (!this.storage || !this.dictionaryCache) throw new NotFoundException('Key not found');
    return this.hydrateFromMedium(space.id, input.key);
  }

  /**
   * Zero-IO fast path: serve the row directly when its block is
   * continuously held and no lapse gap is pending. The held lock pins
   * the block's key set, so no newer medium state can exist for it.
   */
  private serveDirect(
    spaceId: string,
    row: {
      key: string;
      value: Buffer | Uint8Array;
      contentType: string | null | undefined;
      version: number;
      updatedAt: Date | null | undefined;
    },
  ): ReadKeyResult | null {
    if (this.needsResync.has(spaceId)) return null;
    const blockId = this.dictionaryCache
      ?.get(spaceId)?.dictionary.entries[row.key]?.blockId;
    if (!blockId) return null;
    if (!this.heldValid(spaceId, blockId)) return null;
    return this.toReadResult(row);
  }

  private toReadResult(row: {
    value: Buffer | Uint8Array;
    contentType: string | null | undefined;
    version: number;
    updatedAt: Date | null | undefined;
  }): ReadKeyResult {
    return {
      value: Buffer.from(row.value),
      contentType: row.contentType ?? null,
      version: row.version,
      updatedAt: row.updatedAt ?? null,
    };
  }

  /**
   * Staleness-indicated medium consult for a live row: compare against
   * the dictionary, and on newer pull boundedly (lock+read) before
   * serving. Falls back to the row itself on any retryable failure
   * (stale-acceptable: we hold a value, just possibly not the newest),
   * with background continuation warming the cache. Terminal version
   * conflicts fail explicitly even with a row present.
   */
  private async consultMedium(
    spaceId: string,
    row: {
      id: string;
      key: string;
      value: Buffer | Uint8Array;
      contentType: string | null | undefined;
      version: number;
      updatedAt: Date | null | undefined;
      lastPersistedVersion: number;
    },
  ): Promise<ReadKeyResult> {
    const key = row.key;
    let lookup;
    try {
      lookup = await this.lookupEntry(spaceId, key);
    } catch (error) {
      if (error instanceof StorageVersionError) {
        await this.setSpaceState(spaceId, 'unhealthy');
        throw new ServiceUnavailableException('Stored data uses a newer format version');
      }
      throw error;
    }
    if (lookup.status === 'unknown') return this.toReadResult(row);
    if (lookup.status === 'absent') {
      if (row.version !== row.lastPersistedVersion) {
        // Dirty row the medium never saw: ours, unflushed. Serve it.
        return this.toReadResult(row);
      }
      // Clean row absent from the medium: deleted elsewhere. Pull the
      // deletion; a concurrent dirtying wins the race instead.
      const deleted = await this.deleteLocalRow(spaceId, key);
      if (!deleted) {
        const current = await this.em.findOne(SpaceKeySchema, { space: spaceId, key });
        if (!current || current.deletedAt) throw new NotFoundException('Key not found');
        return this.toReadResult(current);
      }
      throw new NotFoundException('Key not found');
    }
    if (lookup.keyVersion <= row.version) return this.toReadResult(row);
    const persistence = this.config.get('persistence', { infer: true });
    const deadline = Date.now() + persistence.readTimeoutMs;
    const outcome = await this.raceDeadline(
      this.sharedBlockRead(spaceId, lookup.blockId, key),
      deadline,
    );
    if (outcome === 'timeout') {
      this.refreshInBackground(spaceId, lookup.blockId, [key]);
      return this.toReadResult(row);
    }
    if (outcome.status === 'terminal') {
      await this.setSpaceState(spaceId, 'unhealthy');
      throw new ServiceUnavailableException('Stored data uses a newer format version');
    }
    if (outcome.status !== 'ready') {
      this.refreshInBackground(spaceId, lookup.blockId, [key]);
      return this.toReadResult(row);
    }
    const envelope = outcome.file.entries[key];
    if (!envelope || envelope.keyVersion !== lookup.keyVersion) {
      return this.toReadResult(row);
    }
    const { applied } = await this.upsertFromMedium(spaceId, key, {
      value: Buffer.from(envelope.value, 'base64'),
      version: envelope.keyVersion,
      contentType: envelope.contentType,
    });
    if (!applied) {
      const current = await this.em.findOne(SpaceKeySchema, { space: spaceId, key });
      if (!current || current.deletedAt) throw new NotFoundException('Key not found');
      return this.toReadResult(current);
    }
    return {
      value: Buffer.from(envelope.value, 'base64'),
      contentType: envelope.contentType,
      version: envelope.keyVersion,
      updatedAt: new Date(envelope.keyVersion),
    };
  }

  /**
   * Read-miss hydration: the key is absent locally but may live on the
   * medium. Bounded lock+read with retention; 404 only when genuinely
   * absent, 503 when inconsistent or unreachable (with background
   * continuation warming the cache for the next read).
   */
  private async hydrateFromMedium(spaceId: string, key: string): Promise<ReadKeyResult> {
    const storage = this.storage;
    if (!storage) throw new NotFoundException('Key not found');
    const lookup = await this.lookupEntry(spaceId, key);
    if (lookup.status !== 'hit') throw new NotFoundException('Key not found');
    const persistence = this.config.get('persistence', { infer: true });
    const deadline = Date.now() + persistence.readTimeoutMs;
    const outcome = await this.raceDeadline(
      this.sharedBlockRead(spaceId, lookup.blockId, key),
      deadline,
    );
    if (outcome === 'timeout' || outcome.status === 'busy') {
      this.refreshInBackground(spaceId, lookup.blockId, [key]);
      throw new ServiceUnavailableException('Key data unavailable');
    }
    if (outcome.status === 'missing') {
      throw new ServiceUnavailableException('Key data unavailable');
    }
    if (outcome.status === 'terminal') {
      await this.setSpaceState(spaceId, 'unhealthy');
      throw new ServiceUnavailableException('Stored data uses a newer format version');
    }
    const envelope = outcome.file.entries[key];
    if (!envelope || envelope.keyVersion !== lookup.keyVersion) {
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
      return this.toReadResult(current);
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

  /**
   * Best-effort reservation ahead of the flush. Dict-first always: the
   * dictionary lock precedes every block acquisition so acquisitions are
   * never spent on stale mappings (wasted acquisitions are the expensive
   * part on quota-limited media). Pessimistic holds the dict lock across
   * resolve+acquire; optimistic resolves, acquires, then re-reads to
   * validate with a single corrected retry. Writes never wait on any of
   * this — every failure path abandons silently and the flush covers it.
   */
  private async tryPreLock(spaceId: string, key: string): Promise<void> {
    if (!this.locks) return;
    try {
      const strategy = await this.strategyFor(spaceId);
      if (strategy === 'pessimistic') {
        await this.preLockPessimistic(spaceId, key);
      } else {
        await this.preLockOptimistic(spaceId, key);
      }
    } catch {
      // Best-effort: the flush retries the same sequence under its own
      // locking. A failed pre-lock must never fail the write.
    }
  }

  private heldValid(spaceId: string, blockId: string): boolean {
    const entry = this.preLocks.get(spaceId)?.get(blockId);
    return !!entry && !needsRenew(entry.acquiredAt, PRE_LOCK_LEASE_MS, Date.now());
  }

  private recordPreLock(spaceId: string, blockId: string, fence: string): void {
    let held = this.preLocks.get(spaceId);
    const prev = held?.get(blockId);
    if (prev && prev.fence === fence) {
      // Same-fence re-acquire = renewal: continuity unbroken, the medium
      // could not have advanced under us. No re-sync needed.
      prev.acquiredAt = Date.now();
      return;
    }
    if (!held) {
      held = new Map();
      this.preLocks.set(spaceId, held);
    }
    held.set(blockId, { fence, acquiredAt: Date.now() });
    // Fresh hold after a possible gap: the medium may have advanced
    // unseen, so serve-direct stays off until the next reconcile clears it.
    this.needsResync.add(spaceId);
  }

  /** Singleflighted dict-lock acquisition shared by concurrent pre-locks. */
  private acquireDictionary(spaceId: string): Promise<string | null> {
    // Short-circuit: our own hold is still valid (same clock, exact math —
    // no medium round-trip). Re-acquisition would only renew anyway.
    const coveredUntil = this.dictHeldUntil.get(spaceId) ?? 0;
    if (Date.now() < coveredUntil) return Promise.resolve('held');
    const running = this.dictAcquiring.get(spaceId);
    if (running) return running;
    const attempt = this.doAcquireDictionary(spaceId);
    this.dictAcquiring.set(spaceId, attempt);
    void attempt.finally(() => {
      if (this.dictAcquiring.get(spaceId) === attempt) this.dictAcquiring.delete(spaceId);
    });
    return attempt;
  }

  private async doAcquireDictionary(spaceId: string): Promise<string | null> {
    if (!this.locks) return null;
    try {
      const fence = await this.locks.acquireDictionary(spaceId, this.instanceId, PRELOCK_DICT_LEASE_MS);
      if (fence) this.dictHeldUntil.set(spaceId, Date.now() + PRELOCK_DICT_LEASE_MS);
      return fence;
    } catch {
      return null;
    }
  }

  private async preLockPessimistic(spaceId: string, key: string): Promise<void> {
    if (!this.locks) return;
    const dictFence = await this.acquireDictionary(spaceId);
    if (!dictFence) return;
    // No explicit dict release: the short lease lapses on its own. Our
    // own re-entry renews; anyone else waits out at most the remainder.
    const blockId = await this.locks.locateKeyBlock(spaceId, key);
    if (!blockId) return;
    if (this.heldValid(spaceId, blockId)) return;
    const fence = await this.locks.tryAcquire(
      spaceId,
      blockId,
      this.instanceId,
      PRE_LOCK_LEASE_MS,
    );
    if (!fence) return;
    this.recordPreLock(spaceId, blockId, fence);
  }

  private async preLockOptimistic(spaceId: string, key: string): Promise<void> {
    if (!this.locks) return;
    const first = await this.locks.locateKeyBlock(spaceId, key);
    if (!first) return;
    if (this.heldValid(spaceId, first)) return;
    const fence = await this.locks.tryAcquire(
      spaceId,
      first,
      this.instanceId,
      PRE_LOCK_LEASE_MS,
    );
    if (!fence) return;
    // Validate against a fresh mapping (R2): release + single corrected
    // retry on drift, abandon otherwise. The flush verifies regardless.
    const confirmed = await this.revalidateMapping(spaceId, key, first);
    if (confirmed === first) {
      this.recordPreLock(spaceId, first, fence);
      return;
    }
    await this.locks.release(spaceId, first, this.instanceId).catch(() => undefined);
    if (confirmed) {
      try {
        const fence2 = await this.locks.tryAcquire(
          spaceId,
          confirmed,
          this.instanceId,
          PRE_LOCK_LEASE_MS,
        );
        if (fence2) this.recordPreLock(spaceId, confirmed, fence2);
      } catch {
        // Abandon to the flush.
      }
    }
  }

  /**
   * Fresh mapping check for optimistic validation. Returns the R1 block
   * when the medium is unreadable (trust R1; the flush verifies), null
   * when the mapping genuinely vanished (abandon).
   */
  private async revalidateMapping(
    spaceId: string,
    key: string,
    resolved: string,
  ): Promise<string | null> {
    if (!this.storage) return resolved;
    try {
      const raw = await this.storage.read(spaceId, 'dictionary');
      if (!raw) return null;
      const fresh = parseDictionary(raw);
      this.dictionaryCache?.set(spaceId, fresh);
      return fresh.entries[key]?.blockId ?? null;
    } catch {
      return resolved;
    }
  }

  /**
   * Dictionary entry lookup without locks (provisional by design).
   * `hit` carries the entry; `absent` means a loaded dictionary lacks
   * the key; `unknown` means no dictionary could be established at all
   * (no cache, no file, no medium layer) — callers must not confuse
   * absence with ignorance (Gap-1 deletes only on `absent`).
   */
  private async lookupEntry(
    spaceId: string,
    key: string,
  ): Promise<
    | { status: 'hit'; blockId: string; keyVersion: number }
    | { status: 'absent' }
    | { status: 'unknown' }
  > {
    const cached = this.dictionaryCache?.get(spaceId);
    if (cached) {
      const entry = cached.dictionary.entries[key];
      return entry ? { status: 'hit', blockId: entry.blockId, keyVersion: entry.keyVersion } : { status: 'absent' };
    }
    if (!this.storage) return { status: 'unknown' };
    let raw: Buffer | null;
    try {
      raw = await this.storage.read(spaceId, 'dictionary');
    } catch {
      return { status: 'unknown' };
    }
    if (!raw) return { status: 'unknown' };
    try {
      const fresh = parseDictionary(raw);
      this.dictionaryCache?.set(spaceId, fresh);
      const entry = fresh.entries[key];
      return entry
        ? { status: 'hit', blockId: entry.blockId, keyVersion: entry.keyVersion }
        : { status: 'absent' };
    } catch (error) {
      if (error instanceof StorageVersionError) throw error;
      return { status: 'unknown' };
    }
  }

  /**
   * Strategy-dispatched block acquisition shared by pre-lock, reads, and
   * background refresh. Returns the fencing token and records the hold.
   * Null when busy, unmapped, or unreachable — never throws for those.
   */
  private async acquireBlock(spaceId: string, key: string, blockId: string): Promise<string | null> {
    if (!this.locks) return null;
    const strategy = await this.strategyFor(spaceId);
    if (strategy === 'pessimistic') {
      const dictFence = await this.acquireDictionary(spaceId);
      if (!dictFence) return null;
      const resolved = await this.locks.locateKeyBlock(spaceId, key);
      if (resolved !== blockId) return null;
      const fence = await this.locks.tryAcquire(
        spaceId,
        blockId,
        this.instanceId,
        PRE_LOCK_LEASE_MS,
      );
      if (!fence) return null;
      this.recordPreLock(spaceId, blockId, fence);
      return fence;
    }
    const fence = await this.locks.tryAcquire(
      spaceId,
      blockId,
      this.instanceId,
      PRE_LOCK_LEASE_MS,
    );
    if (!fence) return null;
    const confirmed = await this.revalidateMapping(spaceId, key, blockId);
    if (confirmed !== blockId) {
      await this.locks.release(spaceId, blockId, this.instanceId).catch(() => undefined);
      return null;
    }
    this.recordPreLock(spaceId, blockId, fence);
    return fence;
  }

  /**
   * Single shared block read for one key: strategy-dispatched acquire +
   * read + parse, with the hold recorded for serve-direct. Concurrent
   * readers of the same block join one attempt.
   */
  private sharedBlockRead(
    spaceId: string,
    blockId: string,
    key: string,
  ): Promise<SharedBlockRead> {
    const mapKey = `${spaceId}/${blockId}`;
    const running = this.inflightReads.get(mapKey);
    if (running) return running;
    const attempt = this.attemptBlockRead(spaceId, blockId, key);
    this.inflightReads.set(mapKey, attempt);
    void attempt.finally(() => {
      if (this.inflightReads.get(mapKey) === attempt) this.inflightReads.delete(mapKey);
    });
    return attempt;
  }

  private async attemptBlockRead(
    spaceId: string,
    blockId: string,
    key: string,
  ): Promise<SharedBlockRead> {
    if (!this.storage) return { status: 'busy' };
    try {
      // Without a lock provider there is nothing to acquire: read
      // directly (version checks downstream still apply).
      let fence = '';
      if (this.locks) {
        const acquired = await this.acquireBlock(spaceId, key, blockId);
        if (!acquired) return { status: 'busy' };
        fence = acquired;
      }
      const raw = await this.storage.read(spaceId, `blocks/${blockId}`);
      if (!raw) return { status: 'missing' };
      try {
        return { status: 'ready', blockId, fence, file: parseBlock(raw) };
      } catch (error) {
        if (error instanceof StorageVersionError) return { status: 'terminal' };
        return { status: 'missing' };
      }
    } catch {
      return { status: 'busy' };
    }
  }

  /**
   * Dictionary entry lookup without locks (provisional by design).
   * `hit` carries the entry; `absent` means a loaded dictionary lacks
   * the key (Gap-1 applies); `unknown` means no dictionary could be
   * established (serve local truth; never delete on ignorance).
   * Higher format versions propagate (caller marks unhealthy).
   */
  private async raceDeadline<T>(
    promise: Promise<T>,
    deadline: number,
  ): Promise<T | 'timeout'> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining);
          if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
            (timer as unknown as { unref: () => void }).unref();
          }
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Background refresh continuation: bounded retry loop over the shared
   * block read, pulling newer envelopes for the interested keys.
   * Singleflighted per block; detached from any response; caps bound it;
   * all errors are logged, never thrown. The next read finds warm cache.
   */
  private refreshInBackground(spaceId: string, blockId: string, keys: string[]): void {
    const mapKey = `bg/${spaceId}/${blockId}`;
    if (this.bgRefreshInFlight.has(mapKey)) return;
    const persistence = this.config.get('persistence', { infer: true });
    const maxAttempts = persistence.backgroundMaxAttempts;
    const maxElapsedMs = persistence.backgroundMaxElapsedMs;
    const spacingMs = persistence.readRetrySpacingMs;
    const startedAt = Date.now();
    const slot: { current?: Promise<void> } = {};
    const loop = (async (): Promise<void> => {
      try {
        for (let attempts = 0; ; attempts += 1) {
          if (attempts >= maxAttempts || Date.now() - startedAt > maxElapsedMs) return;
          if (attempts > 0) await sleep(spacingMs * attempts);
          let outcome: SharedBlockRead;
          try {
            outcome = await this.sharedBlockRead(spaceId, blockId, keys[0] ?? '');
          } catch {
            continue;
          }
          if (outcome.status === 'terminal') {
            await this.setSpaceState(spaceId, 'unhealthy').catch(() => undefined);
            return;
          }
          if (outcome.status !== 'ready') continue;
          await this.pullBlockKeys(spaceId, outcome.file, keys);
          return;
        }
      } finally {
        if (this.bgRefreshInFlight.get(mapKey) === slot.current) {
          this.bgRefreshInFlight.delete(mapKey);
        }
      }
    })();
    slot.current = loop;
    this.bgRefreshInFlight.set(mapKey, loop);
    void loop.catch(() => undefined);
  }

  /** Pull newer envelopes for keys of interest (version-ordered, safe). */
  private async pullBlockKeys(
    spaceId: string,
    file: BlockFile,
    keys: string[],
  ): Promise<void> {
    for (const key of keys) {
      const envelope = file.entries[key];
      if (!envelope) continue;
      try {
        await this.upsertFromMedium(spaceId, key, {
          value: Buffer.from(envelope.value, 'base64'),
          version: envelope.keyVersion,
          contentType: envelope.contentType,
        });
      } catch {
        continue;
      }
    }
  }
}
