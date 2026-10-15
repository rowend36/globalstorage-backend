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
} from '@nestjs/common';
import { SpaceKeySchema, SpaceSchema, UserSchema } from '../database/entities';

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
        persistence: { flushDebounceMs: 10, syncCooldownMs: 5000 },
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
    scheduler = new FlushScheduler(config, {
      handle: async (spaceIds: string[]) => {
        handled.push(spaceIds);
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
    const locks = {
      locateKeyBlock: async (spaceId: string, key: string) => {
        located.push({ spaceId, key });
        return 'blk_1';
      },
      tryAcquire: async (spaceId: string, blockId: string) => {
        acquired.push({ spaceId, blockId });
        return 'fence-1';
      },
      release: async () => {},
    } as never;
    const withLocks = buildService(locks);
    await withLocks.writeKey({ ownerId, spaceId: space.id, key: 'k', value: Buffer.from('v') });
    expect(located).toEqual([{ spaceId: space.id, key: 'k' }]);
    expect(acquired).toEqual([{ spaceId: space.id, blockId: 'blk_1' }]);
    expect(withLocks.consumePreLocks(space.id)).toEqual([
      { blockId: 'blk_1', owner: expect.any(String), fence: 'fence-1', acquiredAt: expect.any(Number) },
    ]);
    expect(withLocks.consumePreLocks(space.id)).toEqual([]);

    // Lock contention or failure never fails the write.
    const failing = buildService({
      locateKeyBlock: async () => 'blk_1',
      tryAcquire: async () => null,
      release: async () => {},
    } as never);
    await failing.writeKey({ ownerId, spaceId: space.id, key: 'k2', value: Buffer.from('v') });
    const throwing = buildService({
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

  it('validates key and space names', () => {
    expect(validateKeyName('todos/123')).toBe('todos/123');
    expect(() => validateKeyName('')).toThrow('Key must not be empty');
    expect(() => validateKeyName('a'.repeat(513))).toThrow();
    expect(() => validateKeyName('bad\u0007key')).toThrow('control characters');
    expect(validateSpaceName('  Notes ')).toBe('Notes');
    expect(() => validateSpaceName('  ')).toThrow();
  });
});
