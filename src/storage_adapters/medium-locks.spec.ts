import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DictionaryCache } from './dictionary-cache';
import { MediumLockService, needsRenew } from './medium-locks';
import {
  LOCK_FORMAT,
  emptyDictionary,
  newFence,
  serializeDictionary,
  serializeLock,
} from './formats';
import { LocalFilesystemAdapter } from './local-filesystem.adapter';

describe('needsRenew', () => {
  it('renews inside a proportional margin with a floor', () => {
    // 120s lease → 30s margin (25%).
    expect(needsRenew(0, 120_000, 89_000)).toBe(false);
    expect(needsRenew(0, 120_000, 91_000)).toBe(true);
    // 30s lease → 7.5s margin (25% beats the 5s floor).
    expect(needsRenew(0, 30_000, 22_000)).toBe(false);
    expect(needsRenew(0, 30_000, 23_000)).toBe(true);
    // 10s lease → 5s floor beats 2.5s proportional.
    expect(needsRenew(0, 10_000, 4_000)).toBe(false);
    expect(needsRenew(0, 10_000, 6_000)).toBe(true);
  });
});

describe('MediumLockService', () => {
  let dir: string;
  let adapter: LocalFilesystemAdapter;
  let locks: MediumLockService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gs-locks-'));
    adapter = new LocalFilesystemAdapter({ get: () => ({ directory: dir }) } as never);
    locks = new MediumLockService(adapter, new DictionaryCache());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires, renews for the same owner, and releases', async () => {
    const fence = await locks.acquire('sp_1', 'block/a', 'w1', 60_000);
    expect(fence).toEqual(expect.any(String));
    expect(await locks.acquire('sp_1', 'block/a', 'w2', 60_000)).toBeNull();
    const renewed = await locks.acquire('sp_1', 'block/a', 'w1', 60_000);
    expect(renewed).toBe(fence);
    expect(await locks.renew('sp_1', 'block/a', 'w1', fence as string, 60_000)).toBe(true);
    expect(await locks.renew('sp_1', 'block/a', 'w1', 'wrong-fence', 60_000)).toBe(false);
    expect(await locks.renew('sp_1', 'block/a', 'w2', fence as string, 60_000)).toBe(false);
    await locks.releaseResource('sp_1', 'block/a', 'w2');
    expect(await locks.acquire('sp_1', 'block/a', 'w2', 60_000)).toBeNull();
    await locks.releaseResource('sp_1', 'block/a', 'w1');
    expect(await locks.acquire('sp_1', 'block/a', 'w2', 60_000)).not.toBeNull();
  });

  it('steals expired locks and recovers from corrupt ones', async () => {
    const expired = {
      format: LOCK_FORMAT,
      resource: 'block/a',
      owner: 'crashed',
      fence: newFence(),
      leaseExpiresAt: Date.now() - 1000,
      acquiredAt: Date.now() - 61_000,
    };
    await adapter.write('sp_1', 'locks/block/a', serializeLock(expired));
    const fence = await locks.acquire('sp_1', 'block/a', 'w1', 60_000);
    expect(fence).not.toBeNull();
    expect(fence).not.toBe(expired.fence);

    await adapter.write('sp_1', 'locks/block/b', Buffer.from('garbage'));
    expect(await locks.acquire('sp_1', 'block/b', 'w1', 60_000)).not.toBeNull();
  });

  it('resolves key blocks through the cached dictionary', async () => {
    expect(await locks.locateKeyBlock('sp_1', 'a/1')).toBeNull();
    const dictionary = {
      ...emptyDictionary(),
      dictionaryVersion: 3,
      entries: { 'a/1': { blockId: 'blk_9', keyVersion: 12 } },
      blocks: { blk_9: { keyCount: 1, liveBytes: 10 } },
    };
    await adapter.write('sp_1', 'dictionary', serializeDictionary(dictionary));
    expect(await locks.locateKeyBlock('sp_1', 'a/1')).toBe('blk_9');
    expect(await locks.locateKeyBlock('sp_1', 'missing')).toBeNull();

    // Pre-lock surface delegates to the same lock resources.
    const fence = await locks.tryAcquire('sp_1', 'blk_9', 'engine', 60_000);
    expect(fence).not.toBeNull();
    expect(await locks.tryAcquire('sp_1', 'blk_9', 'other', 60_000)).toBeNull();
    await locks.release('sp_1', 'blk_9', 'engine');

    // Corrupt dictionaries resolve to unknown, not failure.
    await adapter.write('sp_1', 'dictionary', Buffer.from('garbage'));
    locks = new MediumLockService(adapter, new DictionaryCache());
    expect(await locks.locateKeyBlock('sp_1', 'a/1')).toBeNull();
  });
});
