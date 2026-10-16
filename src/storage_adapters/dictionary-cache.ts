import { Injectable } from '@nestjs/common';
import type { DictionaryFile } from './formats';

export interface CachedDictionary {
  dictionary: DictionaryFile;
}

/**
 * In-memory dictionary cache per space. Advisory only: the medium is the
 * source of truth, and every flush re-reads under the held dict lock.
 * Reconcile compares per-key versions directly — no baseline state is
 * kept here, so a cached copy can never suppress a needed sync.
 */
@Injectable()
export class DictionaryCache {
  private readonly cache = new Map<string, CachedDictionary>();

  get(spaceId: string): CachedDictionary | undefined {
    return this.cache.get(spaceId);
  }

  set(spaceId: string, dictionary: DictionaryFile): void {
    this.cache.set(spaceId, { dictionary });
  }

  invalidate(spaceId: string): void {
    this.cache.delete(spaceId);
  }
}
