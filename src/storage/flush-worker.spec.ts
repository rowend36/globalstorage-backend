import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import * as argon2 from 'argon2';
import { StorageEngineService } from '../engine/engine.service';
import { FlushScheduler } from '../engine/flush-scheduler';
import { SpaceKeySchema, SpaceSchema, UserSchema } from '../database/entities';
import { BlockManager } from './block-manager';
import { DictionaryCache } from './dictionary-cache';
import {
  BLOCK_FORMAT,
  DICTIONARY_FORMAT,
  parseDictionary,
  serializeBlock,
  serializeDictionary,
} from './formats';
import { FlushWorker } from './flush-worker';
import { LocalFilesystemAdapter } from './local-filesystem.adapter';
import { MediumLockService } from './medium-locks';

const MB = 1024 * 1024;

const valuesFor = (key: string) =>
  ({
    spaces: { defaultQuotaBytes: 50 * MB, aggregateQuotaBytes: 1024 * MB, maxKeyBytes: 10 * MB },
    persistence: { flushDebounceMs: 10, syncCooldownMs: 0, provider: 'local', directory: '' },
  })[key];

describe('FlushWorker', () => {
  let orm: MikroORM;
  let tmp: string;
  let engine: StorageEngineService;
  let worker: FlushWorker;
  let adapter: LocalFilesystemAdapter;
  let locks: MediumLockService;
  let scheduler: FlushScheduler;
  let handled: string[][];
  let ownerId: string;

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [UserSchema, SpaceSchema, SpaceKeySchema],
    });
    await orm.schema.create();
    const em = orm.em.fork();
    const user = em.create(UserSchema, {
      email: 'flush@example.test',
      passwordHash: await argon2.hash('password123'),
    });
    await em.flush();
    ownerId = user.id;
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gs-flush-'));
    handled = [];
    const config = {
      get: (key: string) =>
        key === 'persistence'
          ? { ...(valuesFor(key) as object), directory: tmp }
          : valuesFor(key),
    } as never;
    scheduler = new FlushScheduler(config);
    scheduler.registerHandler({
      handle: async (spaceIds: string[]) => {
        handled.push(spaceIds);
        return [];
      },
    });
    engine = new StorageEngineService(orm.em.fork(), config, scheduler);
    adapter = new LocalFilesystemAdapter(config);
    const cache = new DictionaryCache();
    locks = new MediumLockService(adapter, cache);
    worker = new FlushWorker(engine, adapter, locks, cache, new BlockManager(), scheduler, config);
  });

  afterEach(async () => {
    await scheduler.onModuleDestroy();
    rmSync(tmp, { recursive: true, force: true });
  });

  afterAll(async () => {
    await orm.close(true);
  });

  const readDictionaryVersion = async (spaceId: string): Promise<number> => {
    const raw = await adapter.read(spaceId, 'dictionary');
    if (!raw) throw new Error('dictionary missing');
    return parseDictionary(raw).dictionaryVersion;
  };

  it('flushes dirty keys to blocks and marks them persisted', async () => {
    const space = await engine.createSpace(ownerId, 'Basic');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'a/1', value: Buffer.from('one') });
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'a/2', value: Buffer.from('two') });
    await worker.handle([space.id]);

    const keys = await adapter.list(space.id, '');
    expect(keys).toContain('dictionary');
    expect(keys.filter((key) => key.startsWith('blocks/'))).toHaveLength(1);
    expect(await readDictionaryVersion(space.id)).toBe(1);

    const status = await engine.getStatus(ownerId, space.id);
    expect(status.pendingKeys).toBe(0);
    expect(status.keyCount).toBe(2);
    expect(await engine.listDirtyKeys(space.id)).toHaveLength(0);

    // Idempotent: a second flush publishes nothing new.
    await worker.handle([space.id]);
    expect(await readDictionaryVersion(space.id)).toBe(1);
  });

  it('purges tombstones and deletes emptied blocks', async () => {
    const space = await engine.createSpace(ownerId, 'Tomb');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'a', value: Buffer.from('1') });
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'b', value: Buffer.from('2') });
    await worker.handle([space.id]);
    await engine.deleteKey({ ownerId, spaceId: space.id, key: 'a' });
    await engine.deleteKey({ ownerId, spaceId: space.id, key: 'b' });
    await worker.handle([space.id]);

    expect(await adapter.list(space.id, 'blocks')).toEqual([]);
    const raw = await adapter.read(space.id, 'dictionary');
    expect(parseDictionary(raw as Buffer).entries).toEqual({});
    expect(await engine.listKeyVersions(space.id)).toEqual([]);
  });

  it('moves keys that outgrow their block', async () => {
    const space = await engine.createSpace(ownerId, 'Move');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'small', value: Buffer.from('s') });
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'grow', value: Buffer.from('g') });
    await worker.handle([space.id]);

    await engine.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'grow',
      value: Buffer.alloc(150 * 1024, 9),
    });
    await worker.handle([space.id]);

    const raw = await adapter.read(space.id, 'dictionary');
    const dictionary = parseDictionary(raw as Buffer);
    expect(dictionary.entries['grow'].blockId).not.toBe(dictionary.entries['small'].blockId);
    expect(Object.keys(dictionary.blocks)).toHaveLength(2);
    const read = await engine.readKey({ ownerId, spaceId: space.id, key: 'grow' });
    expect(read.value.length).toBe(150 * 1024);
  });

  it('reschedules when the dictionary lock is busy', async () => {
    const space = await engine.createSpace(ownerId, 'Busy');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    await locks.acquire(space.id, 'dictionary', 'other-instance', 60_000);
    expect(await worker.handle([space.id])).toEqual([space.id]);
    expect(await adapter.read(space.id, 'dictionary')).toBeNull();

    await locks.releaseResource(space.id, 'dictionary', 'other-instance');
    await worker.handle([space.id]);
    expect(await readDictionaryVersion(space.id)).toBe(1);
  });

  it('marks the space unhealthy on newer dictionary versions', async () => {
    const space = await engine.createSpace(ownerId, 'Future');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    await adapter.write(
      space.id,
      'dictionary',
      Buffer.from(
        JSON.stringify({ format: 'gs-dict/2', dictionaryVersion: 9, entries: {}, blocks: {}, checksum: 'x' }),
      ),
    );
    await worker.handle([space.id]);
    const status = await engine.getStatus(ownerId, space.id);
    expect(status.state).toBe('unhealthy');
    expect(status.pendingKeys).toBe(1);
  });

  it('pulls newer medium state into local rows', async () => {
    const space = await engine.createSpace(ownerId, 'Pull');
    const written = await engine.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'k',
      value: Buffer.from('local'),
    });
    const newer = written.version + 1000;
    const envelopeValue = Buffer.from('remote');
    await adapter.write(
      space.id,
      'blocks/blk_x',
      serializeBlock({
        format: BLOCK_FORMAT,
        blockId: 'blk_x',
        entries: {
          k: {
            value: envelopeValue.toString('base64'),
            keyVersion: newer,
            contentType: 'text/plain',
            updatedAt: new Date(newer).toISOString(),
          },
        },
      }),
    );
    await adapter.write(
      space.id,
      'dictionary',
      serializeDictionary({
        format: DICTIONARY_FORMAT,
        dictionaryVersion: 1,
        entries: { k: { blockId: 'blk_x', keyVersion: newer } },
        blocks: { blk_x: { keyCount: 1, liveBytes: 50 } },
      }),
    );
    await worker.handle([space.id]);

    const read = await engine.readKey({ ownerId, spaceId: space.id, key: 'k' });
    expect(read.value.toString()).toBe('remote');
    expect(read.contentType).toBe('text/plain');
    const status = await engine.getStatus(ownerId, space.id);
    expect(status.pendingKeys).toBe(0);
  });

  it('deletes clean local rows absent from the dictionary (Gap-1)', async () => {
    const space = await engine.createSpace(ownerId, 'Gap1');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'gone', value: Buffer.from('x') });
    await worker.handle([space.id]);
    expect(await engine.listKeyVersions(space.id)).toHaveLength(1);

    const raw = await adapter.read(space.id, 'dictionary');
    const dictionary = parseDictionary(raw as Buffer);
    delete dictionary.entries['gone'];
    await adapter.write(space.id, 'dictionary', serializeDictionary(dictionary));
    await worker.handle([space.id]);
    expect(await engine.listKeyVersions(space.id)).toHaveLength(0);
  });

  it('repushes everything when the dictionary file is gone', async () => {
    const space = await engine.createSpace(ownerId, 'Requeue');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    await worker.handle([space.id]);
    await adapter.delete(space.id, 'dictionary');
    await worker.handle([space.id]);

    expect(await readDictionaryVersion(space.id)).toBe(1);
    const read = await engine.readKey({ ownerId, spaceId: space.id, key: 'k' });
    expect(read.value.toString()).toBe('v');
    expect((await engine.getStatus(ownerId, space.id)).pendingKeys).toBe(0);
  });

  it('purges the medium prefix on space deletion', async () => {
    const space = await engine.createSpace(ownerId, 'Gone');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    await worker.handle([space.id]);
    expect((await adapter.list(space.id, '')).length).toBeGreaterThan(0);
    await engine.deleteSpace(ownerId, space.id);
    await worker.purgeSpace(space.id);
    expect(await adapter.list(space.id, '')).toEqual([]);

    const busy = await engine.createSpace(ownerId, 'BusyDelete');
    await locks.acquire(busy.id, 'dictionary', 'other', 60_000);
    await expect(worker.purgeSpace(busy.id)).rejects.toThrow('Space is busy');
    await locks.releaseResource(busy.id, 'dictionary', 'other');
  });

  it('uses the dictionary from a previous flush without re-reading', async () => {
    const space = await engine.createSpace(ownerId, 'Cache');
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    await worker.handle([space.id]);
    expect(await readDictionaryVersion(space.id)).toBe(1);
    await engine.writeKey({ ownerId, spaceId: space.id, key: 'k2', value: Buffer.from('v2') });
    await worker.handle([space.id]);
    expect(await readDictionaryVersion(space.id)).toBe(2);
    expect((await engine.getStatus(ownerId, space.id)).pendingKeys).toBe(0);
  });
});
