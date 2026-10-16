import { MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import * as argon2 from 'argon2';
import { StorageEngineService } from './engine.service';
import { FlushScheduler } from './flush-scheduler';
import { validateKeyName, validateSpaceName } from './key-utils';
import {
  KeyVersionConflictException,
  QuotaExceededException,
} from './engine.errors';
import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SpaceKeySchema, SpaceSchema, UserSchema } from '../database/entities';
import { DictionaryCache } from '../storage_adapters/dictionary-cache';
import {
  BLOCK_FORMAT,
  DICTIONARY_FORMAT,
  serializeBlock,
  serializeDictionary,
} from '../storage_adapters/formats';

const MB = 1024 * 1024;

const configFor = (overrides: Record<string, unknown> = {}) =>
  ({
    get: (key: string) => {
      const base: Record<string, unknown> = {
        spaces: {
          defaultQuotaBytes: 50 * MB,
          aggregateQuotaBytes: 1024 * MB,
          maxKeyBytes: 10 * MB,
        },
        persistence: {
          flushDebounceMs: 10,
          syncCooldownMs: 5000,
          readTimeoutMs: 5000,
          readRetrySpacingMs: 10,
          backgroundMaxAttempts: 5,
          backgroundMaxElapsedMs: 2000,
        },
      };
      return { ...(base[key] as object), ...(overrides[key] as object) } as never;
    },
  }) as never;

describe('StorageEngineService', () => {
  let orm: MikroORM;
  let service: StorageEngineService;
  let scheduler: FlushScheduler;
  let handled: string[][];
  let ownerId: string;

  const buildService = (locks?: never) => {
    handled = [];
    const config = configFor();
    scheduler = new FlushScheduler(config);
    scheduler.registerHandler({
      handle: async (spaceIds: string[]) => {
        handled.push(spaceIds);
        return [];
      },
    });
    return new StorageEngineService(orm.em.fork(), config, scheduler, locks);
  };

  beforeAll(async () => {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: [UserSchema, SpaceSchema, SpaceKeySchema],
    });
    await orm.schema.create();
    const em = orm.em.fork();
    const user = em.create(UserSchema, {
      email: 'engine@example.test',
      passwordHash: await argon2.hash('password123'),
      roleVersion: 1,
      deletedAt: null,
      name: 'Engine',
      totpSecret: null,
    });
    await em.flush();
    ownerId = user.id;
  });

  beforeEach(() => {
    service = buildService();
  });

  afterEach(async () => {
    await scheduler.onModuleDestroy();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  it('creates spaces with defaults and validates input', async () => {
    const space = await service.createSpace(ownerId, '  Todos  ');
    expect(space.name).toBe('Todos');
    expect(space.quotaBytes).toBe(50 * MB);
    expect(space.usedBytes).toBe(0);
    expect(space.state).toBe('active');

    const custom = await service.createSpace(ownerId, 'Small', 1024);
    expect(custom.quotaBytes).toBe(1024);

    await expect(service.createSpace(ownerId, '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.createSpace(ownerId, 'Zero', 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.createSpace(ownerId, 'Huge', 2048 * MB)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('writes and reads values with strictly increasing timestamp versions', async () => {
    const space = await service.createSpace(ownerId, 'Versions');
    const versions: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const written = await service.writeKey({
        ownerId,
        spaceId: space.id,
        key: 'todos/1',
        value: Buffer.from(`v${index}`),
        contentType: 'application/json',
      });
      versions.push(written.version);
      expect(written.sizeBytes).toBe(2);
    }
    for (let index = 1; index < versions.length; index += 1) {
      expect(versions[index]).toBeGreaterThan(versions[index - 1]);
    }
    const read = await service.readKey({ ownerId, spaceId: space.id, key: 'todos/1' });
    expect(read.value.toString()).toBe('v4');
    expect(read.version).toBe(versions[4]);
    expect(read.contentType).toBe('application/json');

    const status = await service.getStatus(ownerId, space.id);
    expect(status.keyCount).toBe(1);
    expect(status.pendingKeys).toBe(1);
    expect(status.usedBytes).toBe(2);
  });

  it('enforces conditional writes', async () => {
    const space = await service.createSpace(ownerId, 'Conditional');
    await expect(
      service.writeKey({
        ownerId,
        spaceId: space.id,
        key: 'new',
        value: Buffer.from('x'),
        expectedVersion: 123,
      }),
    ).rejects.toBeInstanceOf(KeyVersionConflictException);

    const first = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'new',
      value: Buffer.from('x'),
      expectedVersion: null,
    });
    await expect(
      service.writeKey({
        ownerId,
        spaceId: space.id,
        key: 'new',
        value: Buffer.from('y'),
        expectedVersion: null,
      }),
    ).rejects.toBeInstanceOf(KeyVersionConflictException);

    const second = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'new',
      value: Buffer.from('y'),
      expectedVersion: first.version,
    });
    expect(second.version).toBeGreaterThan(first.version);
    await expect(
      service.writeKey({
        ownerId,
        spaceId: space.id,
        key: 'new',
        value: Buffer.from('stale'),
        expectedVersion: first.version,
      }),
    ).rejects.toMatchObject({ status: 412 });
  });

  it('supports must-exist preconditions', async () => {
    const space = await service.createSpace(ownerId, 'MustExist');
    await expect(
      service.writeKey({
        ownerId,
        spaceId: space.id,
        key: 'missing',
        value: Buffer.from('x'),
        expectedVersion: 'exists',
      }),
    ).rejects.toMatchObject({ status: 412 });
    const created = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'present',
      value: Buffer.from('x'),
    });
    const updated = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'present',
      value: Buffer.from('y'),
      expectedVersion: 'exists',
    });
    expect(updated.version).toBeGreaterThan(created.version);
    const read = await service.readKey({ ownerId, spaceId: space.id, key: 'present' });
    expect(read.value.toString()).toBe('y');
  });

  it('tombstones deletes and revives on rewrite', async () => {
    const space = await service.createSpace(ownerId, 'Delete');
    const written = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'temp',
      value: Buffer.alloc(40, 7),
      contentType: 'application/octet-stream',
    });
    const deleted = await service.deleteKey({ ownerId, spaceId: space.id, key: 'temp' });
    expect(deleted.version).toBeGreaterThan(written.version);

    await expect(
      service.readKey({ ownerId, spaceId: space.id, key: 'temp' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.deleteKey({ ownerId, spaceId: space.id, key: 'temp' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Tombstone row persists (dirty), quota freed, listing excludes it.
    const em = orm.em.fork();
    const row = await em.findOneOrFail(SpaceKeySchema, { space: space.id, key: 'temp' });
    expect(row.deletedAt).not.toBeNull();
    expect(row.value.length).toBe(0);
    expect(row.version).toBeGreaterThan(row.lastPersistedVersion);
    const reloaded = await em.findOneOrFail(SpaceSchema, { id: space.id });
    expect(reloaded.usedBytes).toBe(0);
    expect(await service.listKeys({ ownerId, spaceId: space.id })).toEqual({
      keys: [],
      nextCursor: null,
    });

    // Rewrite revives with version continuity past the tombstone.
    const revived = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'temp',
      value: Buffer.from('back'),
      expectedVersion: null,
    });
    expect(revived.version).toBeGreaterThan(deleted.version);
    const reread = await service.readKey({ ownerId, spaceId: space.id, key: 'temp' });
    expect(reread.value.toString()).toBe('back');
  });

  it('enforces space and aggregate quotas with exact accounting', async () => {
    const tiny = await service.createSpace(ownerId, 'Tiny', 100);
    await service.writeKey({
      ownerId,
      spaceId: tiny.id,
      key: 'a',
      value: Buffer.alloc(60, 1),
    });
    // Exact boundary succeeds.
    await service.writeKey({
      ownerId,
      spaceId: tiny.id,
      key: 'b',
      value: Buffer.alloc(40, 2),
    });
    await expect(
      service.writeKey({ ownerId, spaceId: tiny.id, key: 'c', value: Buffer.alloc(1, 3) }),
    ).rejects.toBeInstanceOf(QuotaExceededException);

    // Overwrite shrinks usage: 60 -> 10 frees 50, then 51 fits.
    await service.writeKey({
      ownerId,
      spaceId: tiny.id,
      key: 'a',
      value: Buffer.alloc(10, 1),
    });
    const after = await service.getStatus(ownerId, tiny.id);
    expect(after.usedBytes).toBe(50);

    const narrow = new StorageEngineService(
      orm.em.fork(),
      configFor({ spaces: { aggregateQuotaBytes: 60 } }),
      scheduler,
    );
    // Aggregate accounting is per owner; isolate with a fresh user.
    const em = orm.em.fork();
    const owner2 = em.create(UserSchema, {
      email: 'aggregate@example.test',
      passwordHash: await argon2.hash('password123'),
    });
    await em.flush();
    const first = await narrow.createSpace(owner2.id, 'Agg1', 50);
    await narrow.writeKey({ ownerId: owner2.id, spaceId: first.id, key: 'a', value: Buffer.alloc(50, 1) });
    const second = await narrow.createSpace(owner2.id, 'Agg2', 50);
    await expect(
      narrow.writeKey({ ownerId: owner2.id, spaceId: second.id, key: 'a', value: Buffer.alloc(20, 2) }),
    ).rejects.toBeInstanceOf(QuotaExceededException);
  });

  it('rejects oversized values', async () => {
    const space = await service.createSpace(ownerId, 'Limits');
    await expect(
      service.writeKey({
        ownerId,
        spaceId: space.id,
        key: 'big',
        value: Buffer.alloc(10 * MB + 1, 1),
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('lists keys with prefix, pagination, and persistence status', async () => {
    const space = await service.createSpace(ownerId, 'Listing');
    for (const key of ['a/1', 'a/2', 'a/3', 'b/1']) {
      await service.writeKey({ ownerId, spaceId: space.id, key, value: Buffer.from(key) });
    }
    await service.deleteKey({ ownerId, spaceId: space.id, key: 'a/2' });
    const first = await service.listKeys({ ownerId, spaceId: space.id, prefix: 'a/', limit: 1 });
    expect(first.keys.map((row) => row.key)).toEqual(['a/1']);
    expect(first.keys[0].status).toBe('pending');
    expect(first.nextCursor).toBe('a/1');
    const second = await service.listKeys({
      ownerId,
      spaceId: space.id,
      prefix: 'a/',
      limit: 10,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.keys.map((row) => row.key)).toEqual(['a/3']);
    expect(second.nextCursor).toBeNull();
  });

  it('hides foreign spaces instead of leaking their existence', async () => {
    const space = await service.createSpace(ownerId, 'Private');
    const stranger = 'someone-else';
    await expect(
      service.readKey({ ownerId: stranger, spaceId: space.id, key: 'x' }),
    ).rejects.toThrow('Space not found');
    await expect(
      service.writeKey({ ownerId: stranger, spaceId: space.id, key: 'x', value: Buffer.from('y') }),
    ).rejects.toThrow('Space not found');
    await expect(
      service.deleteKey({ ownerId: stranger, spaceId: space.id, key: 'x' }),
    ).rejects.toThrow('Space not found');
    await expect(
      service.listKeys({ ownerId: stranger, spaceId: space.id }),
    ).rejects.toThrow('Space not found');
    await expect(service.getStatus(stranger, space.id)).rejects.toThrow('Space not found');
    await expect(
      service.updateSpace(stranger, space.id, { name: 'Hijack' }),
    ).rejects.toThrow('Space not found');
    await expect(service.deleteSpace(stranger, space.id)).rejects.toThrow('Space not found');
  });

  it('tracks persistence marks for the flush worker', async () => {
    const space = await service.createSpace(ownerId, 'Marks');
    const written = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'k',
      value: Buffer.from('v1'),
    });
    expect(await service.markKeyPersisted('missing', written.version)).toBe(false);

    const dirty = await service.listDirtyKeys(space.id);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]).toMatchObject({ key: 'k', version: written.version, deleted: false });
    expect(dirty[0].value.toString()).toBe('v1');

    const versions = await service.listKeyVersions(space.id);
    expect(versions).toEqual([{ key: 'k', version: written.version, deleted: false }]);

    expect(await service.markKeyPersisted(dirty[0].id, written.version + 1)).toBe(false);
    expect(await service.markKeyPersisted(dirty[0].id, written.version)).toBe(true);
    expect(await service.listDirtyKeys(space.id)).toHaveLength(0);

    const status = await service.getStatus(ownerId, space.id);
    expect(status.pendingKeys).toBe(0);
    expect(status.pendingBytes).toBe(0);
  });

  it('purges tombstones and applies medium pulls by recency', async () => {
    const space = await service.createSpace(ownerId, 'Pull');
    const written = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'k',
      value: Buffer.alloc(30, 1),
    });
    const em = orm.em.fork();

    // Stale medium state is ignored.
    await expect(
      service.upsertFromMedium(space.id, 'k', {
        value: Buffer.from('old'),
        version: written.version - 1,
        contentType: null,
      }),
    ).resolves.toEqual({ applied: false });

    // Newer medium state applies, marks persisted, adjusts quota.
    await expect(
      service.upsertFromMedium(space.id, 'k', {
        value: Buffer.from('newer!'),
        version: written.version + 50,
        contentType: 'text/plain',
      }),
    ).resolves.toEqual({ applied: true });
    const pulled = await service.readKey({ ownerId, spaceId: space.id, key: 'k' });
    expect(pulled.value.toString()).toBe('newer!');
    expect(pulled.contentType).toBe('text/plain');
    const status = await service.getStatus(ownerId, space.id);
    expect(status.usedBytes).toBe(6);
    expect(status.pendingKeys).toBe(0);

    // Missing keys are created as persisted.
    await expect(
      service.upsertFromMedium(space.id, 'fresh', {
        value: Buffer.from('hi'),
        version: Date.now(),
        contentType: null,
      }),
    ).resolves.toEqual({ applied: true });
    const freshRow = await em.findOneOrFail(SpaceKeySchema, { space: space.id, key: 'fresh' });

    // Live rows are protected by the deleted guard; tombstones purge once.
    expect(await service.purgeTombstone(freshRow.id)).toBe(false);
    await service.deleteKey({ ownerId, spaceId: space.id, key: 'k' });
    const tombstone = await em.findOneOrFail(SpaceKeySchema, { space: space.id, key: 'k' });
    expect(await service.purgeTombstone(tombstone.id)).toBe(true);
    expect(await service.purgeTombstone(tombstone.id)).toBe(false);
    expect(await service.listKeyVersions(space.id)).toEqual([
      expect.objectContaining({ key: 'fresh', deleted: false }),
    ]);
  });

  it('deletes absent clean rows for the Gap-1 rule and leaves dirty ones', async () => {
    const space = await service.createSpace(ownerId, 'Gap1');
    const written = await service.writeKey({
      ownerId,
      spaceId: space.id,
      key: 'gone',
      value: Buffer.from('x'),
    });
    const em = orm.em.fork();
    const row = await em.findOneOrFail(SpaceKeySchema, { space: space.id, key: 'gone' });

    // Dirty row: leave for the push.
    expect(await service.deleteLocalRow(space.id, 'gone')).toBe(false);
    expect(await service.markKeyPersisted(row.id, written.version)).toBe(true);

    // Clean row absent from the medium: delete locally.
    expect(await service.deleteLocalRow(space.id, 'gone')).toBe(true);
    const status = await service.getStatus(ownerId, space.id);
    expect(status.usedBytes).toBe(0);
    expect(await service.deleteLocalRow(space.id, 'gone')).toBe(false);
    expect(await service.deleteLocalRow(space.id, 'missing')).toBe(false);
  });

  it('updates and deletes spaces with quota guards', async () => {
    const space = await service.createSpace(ownerId, 'Rename', 1000);
    const renamed = await service.updateSpace(ownerId, space.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    await service.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.alloc(100, 1) });
    await expect(service.updateSpace(ownerId, space.id, { quotaBytes: 50 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.updateSpace(ownerId, space.id, { quotaBytes: 2048 * MB }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.deleteSpace(ownerId, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    await service.deleteSpace(ownerId, space.id);
    await expect(service.readKey({ ownerId, spaceId: space.id, key: 'k' })).rejects.toThrow(
      'Space not found',
    );
  });

  it('keeps local reads and writes available on unhealthy spaces', async () => {
    const space = await service.createSpace(ownerId, 'Sick');
    await service.setSpaceState(space.id, 'unhealthy');
    await service.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    const read = await service.readKey({ ownerId, spaceId: space.id, key: 'k' });
    expect(read.value.toString()).toBe('v');
    const status = await service.getStatus(ownerId, space.id);
    expect(status.state).toBe('unhealthy');
    await service.setSpaceState(space.id, 'active');
  });

  it('attempts the write-path pre-lock best-effort', async () => {
    const space = await service.createSpace(ownerId, 'Prelock');
    const located: Array<{ spaceId: string; key: string }> = [];
    const acquired: Array<{ spaceId: string; blockId: string }> = [];
    const dictAcquired: string[] = [];
    const locks = {
      locateKeyBlock: async (spaceId: string, key: string) => {
        located.push({ spaceId, key });
        return 'blk_1';
      },
      acquireDictionary: async (spaceId: string) => {
        dictAcquired.push(spaceId);
        return 'dict-fence';
      },
      tryAcquire: async (spaceId: string, blockId: string) => {
        acquired.push({ spaceId, blockId });
        return 'fence-1';
      },
      release: async () => {},
    } as never;
    const withLocks = buildService(locks);
    await withLocks.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    // Dict-first ordering: dictionary lock precedes block resolution.
    expect(dictAcquired).toEqual([space.id]);
    expect(located).toEqual([{ spaceId: space.id, key: 'k' }]);
    expect(acquired).toEqual([{ spaceId: space.id, blockId: 'blk_1' }]);
    expect(withLocks.consumePreLocks(space.id)).toEqual([
      { blockId: 'blk_1', owner: expect.any(String), fence: 'fence-1', acquiredAt: expect.any(Number) },
    ]);
    expect(withLocks.consumePreLocks(space.id)).toEqual([]);

    // Lock contention or failure never fails the write.
    const failing = buildService({
      acquireDictionary: async () => 'dict-fence',
      locateKeyBlock: async () => 'blk_1',
      tryAcquire: async () => null,
      release: async () => {},
    } as never);
    await failing.writeKey({ ownerId, spaceId: space.id, key: 'k2', value: Buffer.from('v') });
    const throwing = buildService({
      acquireDictionary: async () => {
        throw new Error('medium down');
      },
      locateKeyBlock: async () => {
        throw new Error('medium down');
      },
      tryAcquire: async () => 'fence',
      release: async () => {},
    } as never);
    await throwing.writeKey({ ownerId, spaceId: space.id, key: 'k3', value: Buffer.from('v') });
    // Without a lock provider, writes proceed with no pre-lock attempt.
    await service.writeKey({ ownerId, spaceId: space.id, key: 'k4', value: Buffer.from('v') });
    expect(service.consumePreLocks(space.id)).toEqual([]);
  });

  it('skips pre-lock acquisition for already-held blocks', async () => {
    const space = await service.createSpace(ownerId, 'PrelockSkip');
    let acquires = 0;
    let dictAcquires = 0;
    const locks = {
      locateKeyBlock: async () => 'blk_1',
      acquireDictionary: async () => {
        dictAcquires += 1;
        return 'dict-fence';
      },
      tryAcquire: async () => {
        acquires += 1;
        return 'fence-1';
      },
      release: async () => {},
    } as never;
    const withLocks = buildService(locks);
    await withLocks.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    await withLocks.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v2') });
    expect(acquires).toBe(1);
    // Second write skips both acquisitions: block held-valid (short
    // circuit) and dict hold still valid (no re-acquire).
    expect(dictAcquires).toBe(1);
  });

  it('resolves the lock strategy per space with pessimistic default', async () => {
    const space = await service.createSpace(ownerId, 'Strategy');
    expect(await service.strategyFor(space.id)).toBe('pessimistic');
    expect(await service.strategyFor('missing')).toBe('pessimistic');
    await orm.em.fork().nativeUpdate(
      SpaceSchema,
      { id: space.id },
      { providerConfig: { lockStrategy: 'optimistic' } },
    );
    // Cached default persists until invalidated...
    expect(await service.strategyFor(space.id)).toBe('pessimistic');
    await service.updateSpace(ownerId, space.id, { name: 'Strategy2' });
    expect(await service.strategyFor(space.id)).toBe('optimistic');
  });

  it('pre-locks optimistically with re-read validation', async () => {
    const space = await service.createSpace(ownerId, 'OptPrelock');
    await orm.em.fork().nativeUpdate(
      SpaceSchema,
      { id: space.id },
      { providerConfig: { lockStrategy: 'optimistic' } },
    );
    const acquired: string[] = [];
    const released: string[] = [];
    const locks = {
      locateKeyBlock: async () => 'blk_1',
      acquireDictionary: async () => {
        throw new Error('optimistic path must not touch the dict lock');
      },
      tryAcquire: async (spaceId: string, blockId: string) => {
        acquired.push(blockId);
        return `fence-${blockId}`;
      },
      release: async (spaceId: string, blockId: string) => {
        released.push(blockId);
      },
    } as never;
    // Stub adapter serves R2 mapping reads for validation.
    const store = new Map<string, Buffer>();
    const seedDict = (block: string) => {
      store.set(
        `${space.id}/dictionary`,
        serializeDictionary({
          format: DICTIONARY_FORMAT,
          dictionaryVersion: 1,
          entries: { k: { blockId: block, keyVersion: 1 } },
          blocks: {},
        }),
      );
    };
    seedDict('blk_1');
    const config = configFor();
    const localScheduler = new FlushScheduler(config);
    const adapter = {
      read: async (spaceId: string, key: string) => store.get(`${spaceId}/${key}`) ?? null,
      write: async () => ({ etag: 'x' }),
      delete: async () => {},
      list: async () => [],
      getCapabilities: () => ({
        targetBlockBytes: 100 * 1024,
        conditionalWrites: true,
        lockStrategy: 'pessimistic',
        dictLockLeaseMs: 30_000,
        blockLockLeaseMs: 120_000,
      }),
    } as never;
    const svc = new StorageEngineService(orm.em.fork(), config, localScheduler, locks, adapter, new DictionaryCache());
    await svc.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    expect(acquired).toEqual(['blk_1']);
    expect(released).toEqual([]);

    // Drift between R1 and R2: release wrong hold, acquire corrected once.
    seedDict('blk_2');
    svc.consumePreLocks(space.id);
    await svc.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v2') });
    expect(acquired).toEqual(['blk_1', 'blk_1', 'blk_2']);
    expect(released).toEqual(['blk_1']);
  });

  it('validates key and space names', () => {
    expect(validateKeyName('todos/123')).toBe('todos/123');
    expect(() => validateKeyName('')).toThrow('Key must not be empty');
    expect(() => validateKeyName('a'.repeat(513))).toThrow();
    expect(() => validateKeyName('badkey')).toThrow('control characters');
    expect(validateSpaceName('  Notes ')).toBe('Notes');
    expect(() => validateSpaceName('  ')).toThrow();
  });

  describe('medium hydrate', () => {
    const seedMedium = async (
      store: Map<string, Buffer>,
      spaceId: string,
      key: string,
      blockId: string,
      version: number,
      value: string,
    ) => {
      store.set(
        `${spaceId}/blocks/${blockId}`,
        serializeBlock({
          format: BLOCK_FORMAT,
          blockId,
          entries: {
            [key]: {
              value: Buffer.from(value).toString('base64'),
              keyVersion: version,
              contentType: 'text/plain',
              updatedAt: new Date(version).toISOString(),
            },
          },
        }),
      );
      store.set(
        `${spaceId}/dictionary`,
        serializeDictionary({
          format: DICTIONARY_FORMAT,
          dictionaryVersion: 1,
          entries: { [key]: { blockId, keyVersion: version } },
          blocks: { [blockId]: { keyCount: 1, liveBytes: 10 } },
        }),
      );
    };

    const buildServiceWithMedium = (store: Map<string, Buffer>, reads: string[]) => {
      const adapter = {
        read: async (spaceId: string, resourceKey: string) => {
          reads.push(`${spaceId}/${resourceKey}`);
          return store.get(`${spaceId}/${resourceKey}`) ?? null;
        },
        write: async () => ({ etag: 'x' }),
        delete: async () => {},
        list: async () => [],
        getCapabilities: () => ({
          targetBlockBytes: 100 * 1024,
          conditionalWrites: true,
          lockStrategy: 'pessimistic',
          dictLockLeaseMs: 30_000,
          blockLockLeaseMs: 120_000,
        }),
      } as never;
      const config = configFor();
      const localScheduler = new FlushScheduler(config);
      return new StorageEngineService(
        orm.em.fork(),
        config,
        localScheduler,
        undefined,
        adapter,
        new DictionaryCache(),
      );
    };

    it('hydrates missing rows from the medium as persisted', async () => {
      const space = await service.createSpace(ownerId, 'Hydrate');
      const version = Date.now() + 5000;
      const store = new Map<string, Buffer>();
      const reads: string[] = [];
      await seedMedium(store, space.id, 'remote', 'blk_1', version, 'from-medium');
      const withMedium = buildServiceWithMedium(store, reads);

      const read = await withMedium.readKey({ ownerId, spaceId: space.id, key: 'remote' });
      expect(read.value.toString()).toBe('from-medium');
      expect(read.version).toBe(version);
      expect(read.contentType).toBe('text/plain');
      expect(await withMedium.listDirtyKeys(space.id)).toHaveLength(0);
      // Second read is served locally without touching the medium.
      const before = reads.length;
      await withMedium.readKey({ ownerId, spaceId: space.id, key: 'remote' });
      expect(reads.length).toBe(before);
    });

    it('returns 404 without medium contact for tombstones and unknown keys', async () => {
      const space = await service.createSpace(ownerId, 'Hydrate404');
      await service.writeKey({ ownerId, spaceId: space.id, key: 'gone', value: Buffer.from('x') });
      await service.deleteKey({ ownerId, spaceId: space.id, key: 'gone' });
      const store = new Map<string, Buffer>();
      const reads: string[] = [];
      const withMedium = buildServiceWithMedium(store, reads);
      await expect(
        withMedium.readKey({ ownerId, spaceId: space.id, key: 'gone' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Tombstones never touch the medium (read-your-deletes).
      expect(reads).toEqual([]);
      await expect(
        withMedium.readKey({ ownerId, spaceId: space.id, key: 'nope' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // A genuine miss consults the dictionary once, then 404s.
      expect(reads).toEqual([`${space.id}/dictionary`]);
    });

    it('fails explicitly on inconsistent medium state', async () => {
      const space = await service.createSpace(ownerId, 'HydrateBad');
      const version = Date.now() + 5000;
      const store = new Map<string, Buffer>();
      store.set(
        `${space.id}/dictionary`,
        serializeDictionary({
          format: DICTIONARY_FORMAT,
          dictionaryVersion: 1,
          entries: { k: { blockId: 'blk_missing', keyVersion: version } },
          blocks: {},
        }),
      );
      const reads: string[] = [];
      const withMedium = buildServiceWithMedium(store, reads);
      await expect(
        withMedium.readKey({ ownerId, spaceId: space.id, key: 'k' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('serves directly from held blocks without medium contact', async () => {
      const space = await service.createSpace(ownerId, 'ServeDirect');
      const store = new Map<string, Buffer>();
      store.set(
        `${space.id}/dictionary`,
        serializeDictionary({
          format: DICTIONARY_FORMAT,
          dictionaryVersion: 1,
          entries: { k: { blockId: 'blk_1', keyVersion: 1 } },
          blocks: { blk_1: { keyCount: 1, liveBytes: 10 } },
        }),
      );
      const reads: string[] = [];
      const locks = {
        locateKeyBlock: async () => 'blk_1',
        acquireDictionary: async () => 'dict-fence',
        tryAcquire: async () => 'fence-1',
        release: async () => {},
      } as never;
      const config = configFor();
      const localScheduler = new FlushScheduler(config);
      const svc = new StorageEngineService(
        orm.em.fork(),
        config,
        localScheduler,
        locks,
        {
          read: async (spaceId: string, resourceKey: string) => {
            reads.push(`${spaceId}/${resourceKey}`);
            return store.get(`${spaceId}/${resourceKey}`) ?? null;
          },
          write: async () => ({ etag: 'x' }),
          delete: async () => {},
          list: async () => [],
          getCapabilities: () => ({
            targetBlockBytes: 100 * 1024,
            conditionalWrites: true,
            lockStrategy: 'pessimistic',
            dictLockLeaseMs: 30_000,
            blockLockLeaseMs: 120_000,
          }),
        } as never,
        new DictionaryCache(),
      );
      await svc.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
      // Pre-lock set the re-sync flag: first read consults (loads dict, empty → serves row).
      const first = await svc.readKey({ ownerId, spaceId: space.id, key: 'k' });
      expect(first.value.toString()).toBe('v');
      const afterConsult = reads.length;
      expect(afterConsult).toBeGreaterThan(0);
      // After reconcile clears the flag, the held block serves with zero IO.
      svc.clearNeedsResync(space.id);
      await svc.readKey({ ownerId, spaceId: space.id, key: 'k' });
      expect(reads.length).toBe(afterConsult);
    });

    it('falls back fast on slow medium and warms in background', async () => {
      const space = await service.createSpace(ownerId, 'SlowRead');
      const written = await service.writeKey({
        ownerId,
        spaceId: space.id,
        key: 'k',
        value: Buffer.from('v1'),
      });
      const newer = written.version + 1000;
      const store = new Map<string, Buffer>();
      store.set(
        `${space.id}/dictionary`,
        serializeDictionary({
          format: DICTIONARY_FORMAT,
          dictionaryVersion: 1,
          entries: { k: { blockId: 'blk_1', keyVersion: newer } },
          blocks: { blk_1: { keyCount: 1, liveBytes: 10 } },
        }),
      );
      store.set(
        `${space.id}/blocks/blk_1`,
        serializeBlock({
          format: BLOCK_FORMAT,
          blockId: 'blk_1',
          entries: {
            k: {
              value: Buffer.from('v2').toString('base64'),
              keyVersion: newer,
              contentType: null,
              updatedAt: new Date(newer).toISOString(),
            },
          },
        }),
      );
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const slowAdapter = {
        read: async (spaceId: string, resourceKey: string) => {
          if (resourceKey.startsWith('blocks/')) await sleep(200);
          return store.get(`${spaceId}/${resourceKey}`) ?? null;
        },
        write: async () => ({ etag: 'x' }),
        delete: async () => {},
        list: async () => [],
        getCapabilities: () => ({
          targetBlockBytes: 100 * 1024,
          conditionalWrites: true,
          lockStrategy: 'pessimistic',
          dictLockLeaseMs: 30_000,
          blockLockLeaseMs: 120_000,
        }),
      } as never;
      const config = configFor({
        persistence: {
          readTimeoutMs: 30,
          readRetrySpacingMs: 10,
          backgroundMaxAttempts: 20,
          backgroundMaxElapsedMs: 5000,
        },
      });
      const svc = new StorageEngineService(
        orm.em.fork(),
        config,
        new FlushScheduler(config),
        undefined,
        slowAdapter,
        new DictionaryCache(),
      );
      // Fallback serves the stale row immediately despite the slow block.
      const fallback = await svc.readKey({ ownerId, spaceId: space.id, key: 'k' });
      expect(fallback.value.toString()).toBe('v1');
      // Background continuation pulls the newer version shortly after.
      let current = fallback;
      for (let i = 0; i < 100 && current.version !== newer; i += 1) {
        await sleep(50);
        current = await svc.readKey({ ownerId, spaceId: space.id, key: 'k' });
      }
      expect(current.value.toString()).toBe('v2');
    }, 15000);

    it('singleflights concurrent block reads', async () => {
      const space = await service.createSpace(ownerId, 'Singleflight');
      const version = Date.now() + 5000;
      const store = new Map<string, Buffer>();
      let blockReads = 0;
      const seedBoth = () => {
        store.set(
          `${space.id}/blocks/blk_1`,
          serializeBlock({
            format: BLOCK_FORMAT,
            blockId: 'blk_1',
            entries: {
              k1: { value: Buffer.from('v1').toString('base64'), keyVersion: version, contentType: null, updatedAt: new Date(version).toISOString() },
              k2: { value: Buffer.from('v2').toString('base64'), keyVersion: version, contentType: null, updatedAt: new Date(version).toISOString() },
            },
          }),
        );
        store.set(
          `${space.id}/dictionary`,
          serializeDictionary({
            format: DICTIONARY_FORMAT,
            dictionaryVersion: 1,
            entries: {
              k1: { blockId: 'blk_1', keyVersion: version },
              k2: { blockId: 'blk_1', keyVersion: version },
            },
            blocks: { blk_1: { keyCount: 2, liveBytes: 20 } },
          }),
        );
      };
      seedBoth();
      const config = configFor();
      const svc = new StorageEngineService(
        orm.em.fork(),
        config,
        new FlushScheduler(config),
        undefined,
        {
          read: async (spaceId: string, resourceKey: string) => {
            if (resourceKey.startsWith('blocks/')) {
              blockReads += 1;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return store.get(`${spaceId}/${resourceKey}`) ?? null;
          },
          write: async () => ({ etag: 'x' }),
          delete: async () => {},
          list: async () => [],
          getCapabilities: () => ({
            targetBlockBytes: 100 * 1024,
            conditionalWrites: true,
            lockStrategy: 'pessimistic',
            dictLockLeaseMs: 30_000,
            blockLockLeaseMs: 120_000,
          }),
        } as never,
        new DictionaryCache(),
      );
      const [r1, r2] = await Promise.all([
        svc.readKey({ ownerId, spaceId: space.id, key: 'k1' }),
        svc.readKey({ ownerId, spaceId: space.id, key: 'k2' }),
      ]);
      expect(r1.value.toString()).toBe('v1');
      expect(r2.value.toString()).toBe('v2');
      expect(blockReads).toBe(1);
    }, 15000);

    it('pulls Gap-1 deletions inline on read', async () => {
      const space = await service.createSpace(ownerId, 'Gap1Read');
      const written = await service.writeKey({
        ownerId,
        spaceId: space.id,
        key: 'gone',
        value: Buffer.from('x'),
      });
      const store = new Map<string, Buffer>();
      store.set(
        `${space.id}/dictionary`,
        serializeDictionary({
          format: DICTIONARY_FORMAT,
          dictionaryVersion: 1,
          entries: {},
          blocks: {},
        }),
      );
      const config = configFor();
      const svc = new StorageEngineService(
        orm.em.fork(),
        config,
        new FlushScheduler(config),
        undefined,
        {
          read: async (spaceId: string, resourceKey: string) =>
            store.get(`${spaceId}/${resourceKey}`) ?? null,
          write: async () => ({ etag: 'x' }),
          delete: async () => {},
          list: async () => [],
          getCapabilities: () => ({
            targetBlockBytes: 100 * 1024,
            conditionalWrites: true,
            lockStrategy: 'pessimistic',
            dictLockLeaseMs: 30_000,
            blockLockLeaseMs: 120_000,
          }),
        } as never,
        new DictionaryCache(),
      );
      // Dirty row the medium never saw: served, not deleted.
      const served = await svc.readKey({ ownerId, spaceId: space.id, key: 'gone' });
      expect(served.value.toString()).toBe('x');
      // Once clean, the absent entry pulls the deletion: 404 + row gone.
      const dirty = await svc.listDirtyKeys(space.id);
      expect(await svc.markKeyPersisted(dirty[0].id, written.version)).toBe(true);
      await expect(
        svc.readKey({ ownerId, spaceId: space.id, key: 'gone' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await svc.listKeyVersions(space.id)).toHaveLength(0);
    });
  });
});
