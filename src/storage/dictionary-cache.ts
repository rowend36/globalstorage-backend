import { Injectable } from '@nestjs/common';
import type { DictionaryFile } from './formats';

export interface CachedDictionary {
  dictionary: DictionaryFile;
  blockVersions: Map<string, number>;
}

/**
 * In-memory dictionary cache per space. Advisory only: the medium is the
 * source of truth, and every flush re-reads under the held dict lock.
 * Stored alongside are the last-seen block versions that drive the
 * reconcile fast path (only changed blocks are descended into).
 */
@Injectable()
export class DictionaryCache {
  private readonly cache = new Map<string, CachedDictionary>();

  get(spaceId: string): CachedDictionary | undefined {
    return this.cache.get(spaceId);
  }

  set(spaceId: string, dictionary: DictionaryFile): void {
    this.cache.set(spaceId, {
      dictionary,
      blockVersions: new Map(
        Object.entries(dictionary.blocks).map(([blockId, stats]) => [
          blockId,
          stats.blockVersion,
        ]),
      ),
    });
  }

  invalidate(spaceId: string): void {
    this.cache.delete(spaceId);
  }
}
