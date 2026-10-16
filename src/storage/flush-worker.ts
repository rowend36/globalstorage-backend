import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageEngineService } from '../engine/engine.service';
import { FlushScheduler } from '../engine/flush-scheduler';
import type { FlushHandler } from '../engine/ports';
import type { AppConfig } from '../config/configuration';
import { BlockManager } from './block-manager';
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
import { MediumLockService } from './medium-locks';

/** Leases must cover debounce plus the apply phase; renewed past half-life. */
const LOCK_LEASE_MS = 120_000;

interface HeldLock {
  resource: string;
  owner: string;
  fence: string;
  acquiredAt: number;
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
  private readonly ownerId = randomUUID();
  private readonly lastSyncAt = new Map<string, number>();

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
   */
  async purgeSpace(spaceId: string): Promise<void> {
    const fence = await this.locks.acquire(spaceId, 'dictionary', this.ownerId, LOCK_LEASE_MS);
    if (!fence) throw new ConflictException('Space is busy; retry the delete');
    try {
      const keys = await this.adapter.list(spaceId, '');
      const dataFirst = [
        ...keys.filter((key) => !key.startsWith('locks/')),
        ...keys.filter((key) => key.startsWith('locks/')),
      ];
      for (const key of dataFirst) await this.adapter.delete(spaceId, key);
    } finally {
      await this.locks.releaseResource(spaceId, 'dictionary', this.ownerId);
      this.cache.invalidate(spaceId);
      this.lastSyncAt.delete(spaceId);
    }
  }

  private async flushSpace(spaceId: string): Promise<'done' | 'retry'> {
    const space = await this.engine.getSpace(spaceId);
    if (!space) return 'done';
    if (space.state === 'unhealthy') {
      this.logger.warn(`Skipping flush for unhealthy space ${spaceId}`);
      return 'done';
    }
    const configured = (space.providerConfig as { targetBlockBytes?: unknown } | null)
      ?.targetBlockBytes;
    const targetBytes =
      typeof configured === 'number' && configured > 0
        ? Math.floor(configured)
        : this.adapter.getCapabilities().targetBlockBytes;

    const dictFence = await this.locks.acquire(
      spaceId,
      'dictionary',
      this.ownerId,
      LOCK_LEASE_MS,
    );
    if (!dictFence) return 'retry';
    const held: HeldLock[] = [
      { resource: 'dictionary', owner: this.ownerId, fence: dictFence, acquiredAt: Date.now() },
    ];
    try {
      let dictionary = await this.readDictionary(spaceId);
      if (!dictionary) {
        // No dictionary: medium state unknown. Requeue everything so no
        // row claiming persisted status is silently missing outside.
        await this.engine.requeueSpace(spaceId);
      }

      const cooldown = this.config.get('persistence', { infer: true }).syncCooldownMs;
      const lastSync = this.lastSyncAt.get(spaceId) ?? 0;
      if (dictionary && Date.now() - lastSync >= cooldown) {
        await this.reconcile(spaceId, dictionary);
        this.lastSyncAt.set(spaceId, Date.now());
        this.cache.set(spaceId, dictionary);
      }

      const dirty = await this.engine.listDirtyKeys(spaceId);
      if (dirty.length === 0) return 'done';

      const plan = this.blocks.planLayout(dictionary, dirty, targetBytes);

      // Fold pre-locks: adopt needed blocks by renewing them into the
      // worker lease (verifies they are still ours), release the rest.
      const needed = [...new Set(plan.deltas.map((delta) => delta.blockId))].sort();
      const heldBlocks = new Map<string, { owner: string; fence: string }>();
      for (const pre of this.engine.consumePreLocks(spaceId)) {
        if (!needed.includes(pre.blockId)) {
          await this.locks.release(spaceId, pre.blockId, pre.owner);
          continue;
        }
        const adopted = await this.locks.renew(
          spaceId,
          `block/${pre.blockId}`,
          pre.owner,
          pre.fence,
          LOCK_LEASE_MS,
        );
        if (!adopted) continue;
        heldBlocks.set(pre.blockId, { owner: pre.owner, fence: pre.fence });
        held.push({
          resource: `block/${pre.blockId}`,
          owner: pre.owner,
          fence: pre.fence,
          acquiredAt: Date.now(),
        });
      }
      for (const blockId of needed) {
        if (heldBlocks.has(blockId)) continue;
        const fence = await this.locks.acquire(
          spaceId,
          `block/${blockId}`,
          this.ownerId,
          LOCK_LEASE_MS,
        );
        if (!fence) return 'retry';
        heldBlocks.set(blockId, { owner: this.ownerId, fence });
        held.push({
          resource: `block/${blockId}`,
          owner: this.ownerId,
          fence,
          acquiredAt: Date.now(),
        });
      }

      const rendered = new Map<
        string,
        { bytes: Buffer; version: number; keyCount: number; liveBytes: number }
      >();
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

      for (const row of dirty) {
        // Guarded ops: a concurrently revived key misses its version
        // match (stays dirty for the next flush); a concurrently deleted
        // key is already a tombstone (purge is a no-op for live rows).
        if (row.deleted) await this.engine.purgeTombstone(row.id);
        else await this.engine.markKeyPersisted(row.id, row.version);
      }
      return 'done';
    } finally {
      for (const lock of held) {
        await this.locks.releaseResource(spaceId, lock.resource, lock.owner);
      }
    }
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

  private async reconcile(spaceId: string, dictionary: DictionaryFile): Promise<void> {
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
      await this.engine.upsertFromMedium(spaceId, key, {
        value: Buffer.from(envelope.value, 'base64'),
        version: envelope.keyVersion,
        contentType: envelope.contentType,
      });
    }
    for (const row of local) {
      if (!dictionary.entries[row.key]) await this.engine.deleteLocalRow(spaceId, row.key);
    }
  }

  /**
   * Verify every held lock still carries our fence, renewing past
   * half-lease. Returns false when a lock was lost (caller reschedules).
   * Sound: a lock cannot be stolen while our lease is valid, and any
   * steal replaces the fence — so fence-match plus a timely renew is
   * sufficient. (Cross-instance clock skew is a documented limitation.)
   */
  private async ensureHeld(spaceId: string, held: HeldLock[]): Promise<boolean> {
    for (const lock of held) {
      if (Date.now() - lock.acquiredAt < LOCK_LEASE_MS / 2) continue;
      const renewed = await this.locks.renew(
        spaceId,
        lock.resource,
        lock.owner,
        lock.fence,
        LOCK_LEASE_MS,
      );
      if (!renewed) return false;
      lock.acquiredAt = Date.now();
    }
    return true;
  }
}
