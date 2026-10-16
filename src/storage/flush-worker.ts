import { ConflictException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INSTANCE_ID } from '../engine/instance';
import { StorageEngineService, type DirtyKey } from '../engine/engine.service';
import { FlushScheduler } from '../engine/flush-scheduler';
import type { FlushHandler } from '../engine/ports';
import type { AppConfig } from '../config/configuration';
import { BlockManager, type RenderedBlock } from './block-manager';
import { DictionaryCache } from './dictionary-cache';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
} from './storage-adapter.port';
import {
  StorageVersionError,
  parseBlock,
  parseDictionary,
  serializeDictionary,
  type BlockFile,
  type DictionaryFile,
} from './formats';
import { MediumLockService, needsRenew } from './medium-locks';

/** Reconcile discovery, returned for the future watch layer (logged for now). */
export interface ChangeEvent {
  spaceId: string;
  key: string;
  oldVersion: number | null;
  newVersion: number;
  operation: 'upsert' | 'delete';
}

interface HeldLock {
  resource: string;
  owner: string;
  fence: string;
  acquiredAt: number;
  leaseMs: number;
}

/** Internal unwind: space marked unhealthy, flush ends without reschedule. */
class AbortFlush extends Error {}

/**
 * Drains dirty keys to the storage medium. One space at a time, each
 * under its held dictionary lock: reconcile (pull newer medium state),
 * plan the layout, lock every touched block, apply blocks + dictionary
 * as one committed change, mark persisted, release everything.
 * Version conditions make races with concurrent local writes self-healing.
 */
@Injectable()
export class FlushWorker implements FlushHandler, OnModuleInit {
  private readonly logger = new Logger(FlushWorker.name);
  private readonly ownerId = INSTANCE_ID;
  private readonly lastSyncAt = new Map<string, number>();
  private readonly lastChanges = new Map<string, ChangeEvent[]>();

  constructor(
    private readonly engine: StorageEngineService,
    @Inject(STORAGE_ADAPTER) private readonly adapter: StorageAdapter,
    private readonly locks: MediumLockService,
    private readonly cache: DictionaryCache,
    private readonly blocks: BlockManager,
    private readonly scheduler: FlushScheduler,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Self-registration (NOT via DI): the engine needs the scheduler and
   * the scheduler dispatches to this worker, so constructor-injecting the
   * handler into the scheduler would close a resolution cycle. Registering
   * here runs after instantiation, when the graph is already built.
   */
  onModuleInit(): void {
    this.scheduler.registerHandler(this);
  }

  async handle(spaceIds: string[]): Promise<string[]> {
    const skipped: string[] = [];
    for (const spaceId of spaceIds) {
      try {
        const outcome = await this.flushSpace(spaceId);
        if (outcome === 'retry') skipped.push(spaceId);
      } catch (error) {
        if (error instanceof AbortFlush) continue;
        this.logger.error(
          `Flush failed for space ${spaceId}; retrying on next schedule`,
          error instanceof Error ? error.stack : undefined,
        );
        skipped.push(spaceId);
      }
    }
    return skipped;
  }

  /**
   * Wipe a deleted space's medium prefix. Called after the engine removed
   * the rows. Fails with 409 while a flush holds the dictionary lock.
   * Lock files vanish with the prefix wipe itself (data deletion, not
   * lifecycle release).
   */
  async purgeSpace(spaceId: string): Promise<void> {
    const caps = this.adapter.getCapabilities();
    const fence = await this.locks.acquire(spaceId, 'dictionary', this.ownerId, caps.dictLockLeaseMs);
    if (!fence) throw new ConflictException('Space is busy; retry the delete');
    try {
      const keys = await this.adapter.list(spaceId, '');
      const dataFirst = [
        ...keys.filter((key) => !key.startsWith('locks/')),
        ...keys.filter((key) => key.startsWith('locks/')),
      ];
      for (const key of dataFirst) await this.adapter.delete(spaceId, key);
    } finally {
      this.cache.invalidate(spaceId);
      this.lastSyncAt.delete(spaceId);
      this.lastChanges.delete(spaceId);
    }
  }

  /** Most recent reconcile discoveries, for observability and future watch. */
  getLastChanges(spaceId: string): ChangeEvent[] {
    return this.lastChanges.get(spaceId) ?? [];
  }

  private lockConfig(space: { providerConfig: Record<string, unknown> | null }): {
    dictLeaseMs: number;
    blockLeaseMs: number;
    targetBytes: number;
  } {
    const caps = this.adapter.getCapabilities();
    const override = (space.providerConfig ?? {}) as {
      targetBlockBytes?: unknown;
      dictLockLeaseMs?: unknown;
      blockLockLeaseMs?: unknown;
    };
    const positive = (value: unknown, fallback: number): number =>
      typeof value === 'number' && value > 0 ? Math.floor(value) : fallback;
    return {
      dictLeaseMs: positive(override.dictLockLeaseMs, caps.dictLockLeaseMs),
      blockLeaseMs: positive(override.blockLockLeaseMs, caps.blockLockLeaseMs),
      targetBytes: positive(override.targetBlockBytes, caps.targetBlockBytes),
    };
  }

  private async flushSpace(spaceId: string): Promise<'done' | 'retry'> {
    const space = await this.engine.getSpace(spaceId);
    if (!space) return 'done';
    if (space.state === 'unhealthy') {
      this.logger.warn(`Skipping flush for unhealthy space ${spaceId}`);
      return 'done';
    }
    const { dictLeaseMs, blockLeaseMs, targetBytes } = this.lockConfig(space);

    // Adopt pre-locks up front (dict-free renew-verify). Survivors feed
    // both paths; the registry is consumed either way.
    const adopted = await this.adoptPreLocks(spaceId, blockLeaseMs);

    // Fast path needs dirty keys; an idle flush still runs the structural
    // path so cooldown-gated reconcile (Gap-1 deletes, pulls) happens.
    const dirty = await this.engine.listDirtyKeys(spaceId);
    if (dirty.length > 0 && (await this.tryFastPath(spaceId, dirty, targetBytes, adopted))) {
      return 'done';
    }
    return this.structuralFlush(spaceId, space, targetBytes, dictLeaseMs, blockLeaseMs, adopted);
  }

  /**
   * Adopt registry pre-locks into the worker lease, dropping the rest.
   * Renewal (not re-acquire) verifies they are still ours; failures are
   * dropped (re-acquired fresh below if still needed). Returns blockId →
   * hold with precise lease windows for ensureHeld.
   */
  private async adoptPreLocks(
    spaceId: string,
    blockLeaseMs: number,
  ): Promise<Map<string, { owner: string; fence: string; acquiredAt: number; leaseMs: number }>> {
    const adopted = new Map<string, { owner: string; fence: string; acquiredAt: number; leaseMs: number }>();
    for (const pre of this.engine.consumePreLocks(spaceId)) {
      const ok = await this.locks.renew(
        spaceId,
        `block/${pre.blockId}`,
        pre.owner,
        pre.fence,
        blockLeaseMs,
      );
      if (!ok) continue;
      adopted.set(pre.blockId, { owner: pre.owner, fence: pre.fence, acquiredAt: Date.now(), leaseMs: blockLeaseMs });
    }
    return adopted;
  }

  /**
   * Fast path: no dictionary file read, no dict lock, no reconcile, no
   * publish. Valid only when the cached mapping covers every dirty key
   * with no structural need (no tombstones, no moves, no new blocks, no
   * deletes), the cooldown is fresh, versions gate pass, and every needed
   * block is already held. Anything else falls through to structural.
   */
  private async tryFastPath(
    spaceId: string,
    dirty: DirtyKey[],
    targetBytes: number,
    adopted: Map<string, { owner: string; fence: string; acquiredAt: number; leaseMs: number }>,
  ): Promise<boolean> {
    const cached = this.cache.get(spaceId);
    if (!cached) return false;
    const cooldown = this.config.get('persistence', { infer: true }).syncCooldownMs;
    const lastSync = this.lastSyncAt.get(spaceId) ?? 0;
    if (Date.now() - lastSync >= cooldown) return false;
    if (dirty.some((row) => row.deleted)) return false;
    const entries = cached.dictionary.entries;
    for (const row of dirty) {
      const entry = entries[row.key];
      if (!entry || entry.keyVersion > row.version) return false;
    }
    const plan = this.blocks.planLayout(cached.dictionary, dirty, targetBytes);
    if (plan.deleteBlocks.length > 0) return false;
    const needed: string[] = [];
    for (const delta of plan.deltas) {
      if (delta.isNew) return false;
      for (const row of delta.upserts) {
        if (entries[row.key]?.blockId !== delta.blockId) return false;
      }
      if (!adopted.has(delta.blockId)) return false;
      needed.push(delta.blockId);
    }
    const held: HeldLock[] = needed.map((blockId) => {
      const lock = adopted.get(blockId) as { owner: string; fence: string; acquiredAt: number; leaseMs: number };
      return {
        resource: `block/${blockId}`,
        owner: lock.owner,
        fence: lock.fence,
        acquiredAt: lock.acquiredAt,
        leaseMs: lock.leaseMs,
      };
    });
    for (const delta of plan.deltas) {
      if (!(await this.ensureHeld(spaceId, held))) return false;
      const old = await this.readBlockFile(spaceId, delta.blockId);
      let rebuild = new Map<string, { value: Buffer; version: number; contentType: string | null }>();
      if (!old) {
        rebuild = await this.rebuildValues(spaceId, delta.blockId, cached.dictionary, delta.removes);
      }
      const renderedBlock = this.blocks.renderBlock(delta, old, rebuild);
      await this.adapter.write(spaceId, `blocks/${delta.blockId}`, renderedBlock.bytes);
    }
    for (const row of dirty) {
      await this.engine.markKeyPersisted(row.id, row.version);
    }
    return true;
  }

  /**
   * Structural path: dict lock, fresh dictionary, reconcile, plan with
   * moves/creates/deletes, publish. Lapse-based lifecycle throughout —
   * nothing is explicitly released (stale pre-locks were already dropped
   * at adoption; the purge wipe handles deletion).
   */
  private async structuralFlush(
    spaceId: string,
    space: { providerConfig: Record<string, unknown> | null },
    targetBytes: number,
    dictLeaseMs: number,
    blockLeaseMs: number,
    adopted: Map<string, { owner: string; fence: string; acquiredAt: number; leaseMs: number }>,
  ): Promise<'done' | 'retry'> {
    const dictFence = await this.locks.acquire(
      spaceId,
      'dictionary',
      this.ownerId,
      dictLeaseMs,
    );
    if (!dictFence) return 'retry';
    const held: HeldLock[] = [
      {
        resource: 'dictionary',
        owner: this.ownerId,
        fence: dictFence,
        acquiredAt: Date.now(),
        leaseMs: dictLeaseMs,
      },
    ];
    let dictionary = await this.readDictionary(spaceId);
    if (!dictionary) {
      // No dictionary: medium state unknown. Requeue everything so no
      // row claiming persisted status is silently missing outside.
      await this.engine.requeueSpace(spaceId);
    }

    const cooldown = this.config.get('persistence', { infer: true }).syncCooldownMs;
    const lastSync = this.lastSyncAt.get(spaceId) ?? 0;
    if (dictionary && Date.now() - lastSync >= cooldown) {
      const events = await this.reconcile(spaceId, dictionary);
      this.lastChanges.set(spaceId, events);
      this.lastSyncAt.set(spaceId, Date.now());
      this.cache.set(spaceId, dictionary);
      this.engine.clearNeedsResync(spaceId);
    }

    const fresh = await this.engine.listDirtyKeys(spaceId);
    if (fresh.length === 0) return 'done';

    const plan = this.blocks.planLayout(dictionary, fresh, targetBytes);
    const needed = [...new Set(plan.deltas.map((delta) => delta.blockId))].sort();
    const heldBlocks = new Map<string, { owner: string; fence: string; acquiredAt: number; leaseMs: number }>();
    for (const [blockId, lock] of adopted) {
      if (!needed.includes(blockId)) continue;
      heldBlocks.set(blockId, lock);
      held.push({
        resource: `block/${blockId}`,
        owner: lock.owner,
        fence: lock.fence,
        acquiredAt: lock.acquiredAt,
        leaseMs: lock.leaseMs,
      });
    }
    for (const blockId of needed) {
      if (heldBlocks.has(blockId)) continue;
      const fence = await this.locks.acquire(
        spaceId,
        `block/${blockId}`,
        this.ownerId,
        blockLeaseMs,
      );
      if (!fence) return 'retry';
      heldBlocks.set(blockId, { owner: this.ownerId, fence, acquiredAt: Date.now(), leaseMs: blockLeaseMs });
      held.push({
        resource: `block/${blockId}`,
        owner: this.ownerId,
        fence,
        acquiredAt: Date.now(),
        leaseMs: blockLeaseMs,
      });
    }

    const rendered = new Map<string, RenderedBlock>();
    for (const delta of plan.deltas) {
      if (!(await this.ensureHeld(spaceId, held))) return 'retry';
      const old = await this.readBlockFile(spaceId, delta.blockId);
      let rebuild = new Map<string, { value: Buffer; version: number; contentType: string | null }>();
      if (!old && !delta.isNew) {
        rebuild = await this.rebuildValues(spaceId, delta.blockId, dictionary, delta.removes);
      }
      const renderedBlock = this.blocks.renderBlock(delta, old, rebuild);
      rendered.set(delta.blockId, renderedBlock);
      await this.adapter.write(spaceId, `blocks/${delta.blockId}`, renderedBlock.bytes);
    }
    for (const gone of plan.deleteBlocks) {
      await this.adapter.delete(spaceId, `blocks/${gone}`);
    }
    const previousBlocks = Object.fromEntries(
      Object.entries(dictionary?.blocks ?? {}).filter(([blockId]) => !plan.deleteBlocks.includes(blockId)),
    );
    const nextDictionary = this.blocks.buildDictionary(
      dictionary?.dictionaryVersion ?? 0,
      plan.entries,
      rendered,
      previousBlocks,
    );
    if (!(await this.ensureHeld(spaceId, held))) return 'retry';
    const dictionaryBytes = serializeDictionary(nextDictionary);
    await this.adapter.write(spaceId, 'dictionary', dictionaryBytes);
    this.cache.set(spaceId, parseDictionary(dictionaryBytes));
    this.lastSyncAt.set(spaceId, Date.now());

    for (const row of fresh) {
      // Guarded ops: a concurrently revived key misses its version
      // match (stays dirty for the next flush); a concurrently deleted
      // key is already a tombstone (purge is a no-op for live rows).
      if (row.deleted) await this.engine.purgeTombstone(row.id);
      else await this.engine.markKeyPersisted(row.id, row.version);
    }
    return 'done';
    // NOTE: no finally-release — lapse-based lifecycle. Locks expire on
    // their own; purge wipe and stale-prelock drops are the only explicit
    // deletions. Releasing here would churn acquisitions on slow media.
  }

  private async readDictionary(spaceId: string): Promise<DictionaryFile | null> {
    const raw = await this.adapter.read(spaceId, 'dictionary');
    if (!raw) return null;
    try {
      return parseDictionary(raw);
    } catch (error) {
      if (error instanceof StorageVersionError) {
        await this.engine.setSpaceState(spaceId, 'unhealthy');
        this.logger.error(`Space ${spaceId} dictionary uses a newer format; marked unhealthy`);
        throw new AbortFlush((error as Error).message);
      }
      // Corrupt dictionary: rebuild from authoritative local rows.
      this.logger.warn(`Space ${spaceId} dictionary unreadable; rebuilding`);
      return null;
    }
  }

  private async readBlockFile(spaceId: string, blockId: string): Promise<BlockFile | null> {
    const raw = await this.adapter.read(spaceId, `blocks/${blockId}`);
    if (!raw) return null;
    try {
      return parseBlock(raw);
    } catch (error) {
      if (error instanceof StorageVersionError) {
        await this.engine.setSpaceState(spaceId, 'unhealthy');
        this.logger.error(`Space ${spaceId} block ${blockId} uses a newer format`);
        throw new AbortFlush((error as Error).message);
      }
      return null;
    }
  }

  private async rebuildValues(
    spaceId: string,
    blockId: string,
    dictionary: DictionaryFile | null,
    removes: string[],
  ): Promise<Map<string, { value: Buffer; version: number; contentType: string | null }>> {
    const mapped = Object.entries(dictionary?.entries ?? {})
      .filter(([, entry]) => entry.blockId === blockId)
      .map(([key]) => key);
    // Removed keys (tombstoned or moved away) are not rebuild inputs:
    // tombstones resolve via the dirty set, moved keys via their
    // destination block's dirty upserts.
    const staying = mapped.filter((key) => !removes.includes(key));
    const rows = await this.engine.getKeyEntries(spaceId, staying);
    const found = new Map(rows.map((row) => [row.key, row]));
    for (const key of staying) {
      if (!found.has(key)) {
        await this.engine.setSpaceState(spaceId, 'unhealthy');
        this.logger.error(`Block ${blockId} references key ${key} with no recoverable copy`);
        throw new AbortFlush(`unrecoverable block ${blockId}`);
      }
    }
    return found;
  }

  private async reconcile(spaceId: string, dictionary: DictionaryFile): Promise<ChangeEvent[]> {
    const events: ChangeEvent[] = [];
    const local = await this.engine.listKeyVersions(spaceId);
    const localByKey = new Map(local.map((row) => [row.key, row]));
    for (const [key, entry] of Object.entries(dictionary.entries)) {
      const row = localByKey.get(key);
      if (row && entry.keyVersion <= row.version) continue;
      const blockRaw = await this.adapter.read(spaceId, `blocks/${entry.blockId}`);
      if (!blockRaw) {
        await this.engine.setSpaceState(spaceId, 'unhealthy');
        throw new AbortFlush(`dictionary references missing block ${entry.blockId}`);
      }
      let envelope;
      try {
        envelope = parseBlock(blockRaw).entries[key];
      } catch (error) {
        if (error instanceof StorageVersionError) {
          await this.engine.setSpaceState(spaceId, 'unhealthy');
          throw new AbortFlush((error as Error).message);
        }
        continue; // Corrupt block: push path rebuilds it from local rows.
      }
      if (!envelope || envelope.keyVersion !== entry.keyVersion) continue;
      const { applied } = await this.engine.upsertFromMedium(spaceId, key, {
        value: Buffer.from(envelope.value, 'base64'),
        version: envelope.keyVersion,
        contentType: envelope.contentType,
      });
      if (applied) {
        events.push({
          spaceId,
          key,
          oldVersion: row?.version ?? null,
          newVersion: envelope.keyVersion,
          operation: 'upsert',
        });
      }
    }
    for (const row of local) {
      if (!dictionary.entries[row.key]) {
        const deleted = await this.engine.deleteLocalRow(spaceId, row.key);
        if (deleted) {
          events.push({ spaceId, key: row.key, oldVersion: row.version, newVersion: row.version, operation: 'delete' });
        }
      }
    }
    if (events.length > 0) {
      this.logger.debug(`Reconciled ${spaceId}: ${events.length} change(s) pulled`);
    }
    return events;
  }

  /**
   * Verify every held lock still carries our fence, renewing inside the
   * proportional margin (no dict lock needed — renewal resolves
   * nothing). Returns false when a lock was lost (caller reschedules).
   * Local-validity fast path first: comfortably-valid leases cost zero
   * medium IO. (Cross-instance clock skew is a documented limitation.)
   */
  private async ensureHeld(spaceId: string, held: HeldLock[]): Promise<boolean> {
    for (const lock of held) {
      if (!needsRenew(lock.acquiredAt, lock.leaseMs, Date.now())) continue;
      const renewed = await this.locks.renew(
        spaceId,
        lock.resource,
        lock.owner,
        lock.fence,
        lock.leaseMs,
      );
      if (!renewed) return false;
      lock.acquiredAt = Date.now();
    }
    return true;
  }
}
