import { Injectable } from '@nestjs/common';
import type { DirtyKey } from '../engine/engine.service';
import {
  BLOCK_FORMAT,
  DICTIONARY_FORMAT,
  newBlockId,
  serializeBlock,
  type BlockEntry,
  type BlockFile,
  type DictionaryFile,
} from './formats';

export interface BlockDelta {
  blockId: string;
  isNew: boolean;
  /** Live dirty keys landing in this block. */
  upserts: DirtyKey[];
  /** Keys leaving this block (moved away or tombstoned). */
  removes: string[];
}

export interface LayoutPlan {
  /** Blocks to (re)write. */
  deltas: BlockDelta[];
  /** Emptied blocks whose files must be deleted. */
  deleteBlocks: string[];
  /** Key-to-block mapping after the plan (stats provisional). */
  entries: Record<string, { blockId: string; keyVersion: number }>;
}

export interface RenderedBlock {
  bytes: Buffer;
  version: number;
  keyCount: number;
  liveBytes: number;
}

export interface RebuildValue {
  value: Buffer;
  version: number;
  contentType: string | null;
}

const ENVELOPE_OVERHEAD_BYTES = 64;

/** Approximate serialized cost of one entry (base64 inflates values 4/3). */
export function estimateEntryBytes(key: string, valueBytes: number, contentType: string | null): number {
  return (
    Buffer.byteLength(key, 'utf8') +
    Math.ceil((valueBytes * 4) / 3) +
    Buffer.byteLength(contentType ?? '', 'utf8') +
    ENVELOPE_OVERHEAD_BYTES
  );
}

export function toBlockEntry(key: DirtyKey): BlockEntry {
  return {
    value: key.value.toString('base64'),
    keyVersion: key.version,
    contentType: key.contentType,
    updatedAt: new Date(key.version).toISOString(),
  };
}

/**
 * Block layout planning. Pure logic over the current dictionary and the
 * dirty set — no medium IO. Tombstones are processed first (they only
 * free space); live keys stay home when they fit, first-fit elsewhere,
 * and oversized values get their own block. Size estimates are
 * conservative (stale-high after removals), so a plan may allocate when
 * an old block technically had room — always correct, occasionally
 * suboptimal. Exact sizes are recomputed at render time.
 */
@Injectable()
export class BlockManager {
  planLayout(
    current: DictionaryFile | null,
    dirty: DirtyKey[],
    targetBytes: number,
  ): LayoutPlan {
    const entries: Record<string, { blockId: string; keyVersion: number }> =
      Object.fromEntries(
        Object.entries(current?.entries ?? {}).map(([key, entry]) => [
          key,
          { blockId: entry.blockId, keyVersion: entry.keyVersion },
        ]),
      );
    const sizes = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const [blockId, stats] of Object.entries(current?.blocks ?? {})) {
      sizes.set(blockId, stats.liveBytes);
      counts.set(blockId, stats.keyCount);
    }
    const deltas = new Map<string, BlockDelta>();
    const touch = (blockId: string, isNew: boolean): BlockDelta => {
      let delta = deltas.get(blockId);
      if (!delta) {
        delta = { blockId, isNew, upserts: [], removes: [] };
        deltas.set(blockId, delta);
      }
      return delta;
    };

    for (const row of dirty) {
      if (!row.deleted) continue;
      const home = entries[row.key];
      if (!home) continue;
      delete entries[row.key];
      counts.set(home.blockId, (counts.get(home.blockId) ?? 1) - 1);
      touch(home.blockId, false).removes.push(row.key);
    }

    const live = dirty.filter((row) => !row.deleted);
    for (const row of live) {
      const need = estimateEntryBytes(row.key, row.value.length, row.contentType);
      const homeId = entries[row.key]?.blockId;
      if (homeId && (sizes.get(homeId) ?? 0) + need <= targetBytes) {
        entries[row.key] = { blockId: homeId, keyVersion: row.version };
        sizes.set(homeId, (sizes.get(homeId) ?? 0) + need);
        touch(homeId, false).upserts.push(row);
        continue;
      }
      if (homeId) {
        counts.set(homeId, (counts.get(homeId) ?? 1) - 1);
        touch(homeId, false).removes.push(row.key);
      }
      let dest: string | null = null;
      if (need <= targetBytes) {
        for (const [blockId, size] of sizes) {
          if (size + need <= targetBytes) {
            dest = blockId;
            break;
          }
        }
      }
      if (!dest) {
        dest = newBlockId();
        sizes.set(dest, 0);
        counts.set(dest, 0);
      }
      entries[row.key] = { blockId: dest, keyVersion: row.version };
      sizes.set(dest, (sizes.get(dest) ?? 0) + need);
      counts.set(dest, (counts.get(dest) ?? 0) + 1);
      touch(dest, !current?.blocks[dest]).upserts.push(row);
    }

    const deleteBlocks: string[] = [];
    for (const [blockId, count] of counts) {
      if (count <= 0 && current?.blocks[blockId]) deleteBlocks.push(blockId);
    }
    // A block created and emptied within one plan leaves no file behind;
    // a block slated for deletion needs no rewrite either.
    const created = new Set(
      [...deltas.values()].filter((delta) => delta.isNew).map((delta) => delta.blockId),
    );
    const gone = new Set(deleteBlocks.filter((blockId) => !created.has(blockId)));
    return {
      deltas: [...deltas.values()].filter(
        (delta) =>
          (delta.upserts.length > 0 || delta.removes.length > 0) && !gone.has(delta.blockId),
      ),
      deleteBlocks: [...gone],
      entries,
    };
  }

  /**
   * Materialize one planned block: start from its current entries (or a
   * rebuild map when the file is missing/corrupt), apply removes and
   * upserts, bump the version, serialize.
   */
  renderBlock(
    delta: BlockDelta,
    old: BlockFile | null,
    rebuild: ReadonlyMap<string, RebuildValue>,
  ): RenderedBlock {
    const entries: Record<string, BlockEntry> = {};
    if (old) {
      for (const [key, entry] of Object.entries(old.entries)) entries[key] = { ...entry };
    } else {
      for (const [key, value] of rebuild) {
        entries[key] = {
          value: value.value.toString('base64'),
          keyVersion: value.version,
          contentType: value.contentType,
          updatedAt: new Date(value.version).toISOString(),
        };
      }
    }
    for (const key of delta.removes) delete entries[key];
    for (const row of delta.upserts) entries[row.key] = toBlockEntry(row);
    const version = (old?.blockVersion ?? 0) + 1;
    const canonical = serializeBlock({
      format: BLOCK_FORMAT,
      blockId: delta.blockId,
      blockVersion: version,
      entries,
    });
    return {
      bytes: canonical,
      version,
      keyCount: Object.keys(entries).length,
      liveBytes: canonical.length,
    };
  }

  buildDictionary(
    previousVersion: number,
    entries: LayoutPlan['entries'],
    rendered: ReadonlyMap<string, RenderedBlock>,
    previousBlocks: Record<string, { blockVersion: number; keyCount: number; liveBytes: number }>,
  ): Omit<DictionaryFile, 'checksum'> {
    const blocks: Record<string, { blockVersion: number; keyCount: number; liveBytes: number }> = {
      ...previousBlocks,
    };
    for (const [blockId, renderedBlock] of rendered) {
      blocks[blockId] = {
        blockVersion: renderedBlock.version,
        keyCount: renderedBlock.keyCount,
        liveBytes: renderedBlock.liveBytes,
      };
    }
    return {
      format: DICTIONARY_FORMAT,
      dictionaryVersion: previousVersion + 1,
      entries,
      blocks,
    };
  }
}
