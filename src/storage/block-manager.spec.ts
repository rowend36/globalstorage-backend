import { BlockManager } from './block-manager';
import { parseBlock } from './formats';
import type { DirtyKey } from '../engine/engine.service';
import type { DictionaryFile } from './formats';

const key = (
  key: string,
  version: number,
  size: number,
  deleted = false,
): DirtyKey => ({
  id: `id-${key}`,
  key,
  version,
  value: Buffer.alloc(size, 7),
  contentType: 'application/octet-stream',
  deleted,
});

const currentDict = (entries: Record<string, { blockId: string; keyVersion: number }>): DictionaryFile =>
  ({
    format: 'gs-dict/1',
    dictionaryVersion: 4,
    entries,
    blocks: {
      blk_1: { keyCount: 2, liveBytes: 300 },
    },
    checksum: 'test-only',
  }) as DictionaryFile;

describe('BlockManager', () => {
  const manager = new BlockManager();

  it('allocates fresh blocks on a new space', () => {
    const plan = manager.planLayout(null, [key('a', 100, 10), key('b', 101, 10)], 100 * 1024);
    expect(plan.deltas).toHaveLength(1);
    expect(plan.deltas[0].isNew).toBe(true);
    expect(plan.deleteBlocks).toEqual([]);
    expect(Object.keys(plan.entries)).toEqual(['a', 'b']);
    const rendered = manager.renderBlock(plan.deltas[0], null, new Map());
    expect(rendered.keyCount).toBe(2);
    expect(parseBlock(rendered.bytes).entries['a'].keyVersion).toBe(100);
  });

  it('splits across blocks at the target size', () => {
    const plan = manager.planLayout(
      null,
      [key('a', 100, 10), key('b', 101, 10), key('c', 102, 10)],
      150,
    );
    expect(plan.deltas.length).toBeGreaterThan(1);
    const assigned = new Set(plan.deltas.flatMap((delta) => delta.upserts.map((row) => row.key)));
    expect(assigned).toEqual(new Set(['a', 'b', 'c']));
  });

  it('isolates oversized values in their own block', () => {
    const plan = manager.planLayout(null, [key('small', 100, 10), key('big', 101, 5000)], 1024);
    const big = plan.deltas.find((delta) => delta.upserts.some((row) => row.key === 'big'));
    const small = plan.deltas.find((delta) => delta.upserts.some((row) => row.key === 'small'));
    expect(big).toBeDefined();
    expect(small).toBeDefined();
    expect(big!.blockId).not.toBe(small!.blockId);
    expect(big!.upserts).toHaveLength(1);
  });

  it('keeps keys home when they fit and moves them when they outgrow', () => {
    const current = currentDict({
      'a/1': { blockId: 'blk_1', keyVersion: 100 },
      'a/2': { blockId: 'blk_1', keyVersion: 101 },
    });
    const stay = manager.planLayout(current, [key('a/1', 200, 10)], 100 * 1024);
    expect(stay.deltas).toHaveLength(1);
    expect(stay.deltas[0].blockId).toBe('blk_1');
    expect(stay.deltas[0].isNew).toBe(false);

    const move = manager.planLayout(current, [key('a/1', 200, 5000)], 1024);
    expect(move.entries['a/1'].blockId).not.toBe('blk_1');
    const source = move.deltas.find((delta) => delta.blockId === 'blk_1');
    expect(source?.removes).toEqual(['a/1']);
    // blk_1 still holds a/2: rewritten, not deleted.
    expect(move.deleteBlocks).not.toContain('blk_1');
  });

  it('deletes blocks emptied by tombstones', () => {
    const current = currentDict({
      'a/1': { blockId: 'blk_1', keyVersion: 100 },
      'a/2': { blockId: 'blk_1', keyVersion: 101 },
    });
    const plan = manager.planLayout(
      current,
      [key('a/1', 200, 0, true), key('a/2', 201, 0, true)],
      100 * 1024,
    );
    expect(plan.entries).toEqual({});
    expect(plan.deleteBlocks).toEqual(['blk_1']);
    expect(plan.deltas).toHaveLength(0);
  });

  it('ignores tombstones for unknown keys', () => {
    const plan = manager.planLayout(null, [key('ghost', 200, 0, true)], 100 * 1024);
    expect(plan.deltas).toHaveLength(0);
    expect(plan.entries).toEqual({});
  });

  it('renders by merging old entries with the plan', () => {
    const old = {
      format: 'gs-block/1',
      blockId: 'blk_1',
      entries: {
        keep: { value: Buffer.from('keep').toString('base64'), keyVersion: 50, contentType: null, updatedAt: new Date(50).toISOString() },
        gone: { value: Buffer.from('gone').toString('base64'), keyVersion: 51, contentType: null, updatedAt: new Date(51).toISOString() },
      },
      checksum: 'test-only',
    };
    const rendered = manager.renderBlock(
      { blockId: 'blk_1', isNew: false, upserts: [key('new', 200, 3)], removes: ['gone'] },
      old as never,
      new Map(),
    );
    const parsed = parseBlock(rendered.bytes);
    expect(Object.keys(parsed.entries).sort()).toEqual(['keep', 'new']);
    expect(parsed.entries['new'].keyVersion).toBe(200);
    expect(rendered.keyCount).toBe(2);
    expect(rendered.liveBytes).toBe(rendered.bytes.length);
  });

  it('builds dictionaries with bumped versions and exact stats', () => {
    const dictionary = manager.buildDictionary(
      4,
      { 'a/1': { blockId: 'blk_1', keyVersion: 200 } },
      new Map([['blk_1', { bytes: Buffer.alloc(10), keyCount: 1, liveBytes: 10 }]]),
      { blk_0: { keyCount: 0, liveBytes: 0 } },
    );
    expect(dictionary.dictionaryVersion).toBe(5);
    expect(dictionary.blocks['blk_1']).toEqual({ keyCount: 1, liveBytes: 10 });
    expect(dictionary.blocks['blk_0']).toEqual({ keyCount: 0, liveBytes: 0 });
  });
});
