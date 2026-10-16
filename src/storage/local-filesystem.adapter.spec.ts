import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFilesystemAdapter } from './local-filesystem.adapter';
import { StorageConflictError } from './storage-adapter.port';

describe('LocalFilesystemAdapter', () => {
  let dir: string;
  let adapter: LocalFilesystemAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gs-adapter-'));
    const config = { get: () => ({ directory: dir }) } as never;
    adapter = new LocalFilesystemAdapter(config);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes, reads, and deletes resources', async () => {
    expect(await adapter.read('sp_1', 'blocks/blk_1')).toBeNull();
    const written = await adapter.write('sp_1', 'blocks/blk_1', Buffer.from('data'));
    expect(written.etag).toHaveLength(64);
    expect((await adapter.read('sp_1', 'blocks/blk_1'))?.toString()).toBe('data');
    await adapter.delete('sp_1', 'blocks/blk_1');
    expect(await adapter.read('sp_1', 'blocks/blk_1')).toBeNull();
    await adapter.delete('sp_1', 'blocks/blk_1');
  });

  it('enforces conditional writes', async () => {
    await adapter.write('sp_1', 'locks/block/a', Buffer.from('l1'), { ifNoneMatch: true });
    await expect(
      adapter.write('sp_1', 'locks/block/a', Buffer.from('l2'), { ifNoneMatch: true }),
    ).rejects.toBeInstanceOf(StorageConflictError);
    const etag = (await adapter.write('sp_1', 'k', Buffer.from('v1'))).etag;
    await adapter.write('sp_1', 'k', Buffer.from('v2'), { ifMatch: etag });
    expect((await adapter.read('sp_1', 'k'))?.toString()).toBe('v2');
    await expect(
      adapter.write('sp_1', 'k', Buffer.from('v3'), { ifMatch: etag }),
    ).rejects.toBeInstanceOf(StorageConflictError);
  });

  it('lists resources under a prefix', async () => {
    expect(await adapter.list('sp_1', '')).toEqual([]);
    await adapter.write('sp_1', 'blocks/b1', Buffer.from('1'));
    await adapter.write('sp_1', 'blocks/b2', Buffer.from('2'));
    await adapter.write('sp_1', 'dictionary', Buffer.from('d'));
    expect(await adapter.list('sp_1', '')).toEqual(['blocks/b1', 'blocks/b2', 'dictionary']);
    expect(await adapter.list('sp_1', 'blocks')).toEqual(['b1', 'b2']);
    expect(await adapter.list('missing', '')).toEqual([]);
  });

  it('refuses path traversal and advertises capabilities', async () => {
    await expect(adapter.read('..', 'dictionary')).rejects.toThrow();
    await expect(adapter.read('sp_1', '../other')).rejects.toThrow();
    await expect(adapter.read('sp_1', '')).rejects.toThrow();
    expect(adapter.getCapabilities()).toEqual({ targetBlockBytes: 100 * 1024, conditionalWrites: true });
  });
});
