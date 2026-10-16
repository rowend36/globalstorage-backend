/**
 * Engine ports. The operational engine never touches the storage medium
 * directly; the flush worker (Phase 3) implements these against adapters.
 * Until a provider is registered, the engine degrades gracefully: writes
 * still commit locally and stay pending, pre-locking is skipped.
 */

/** Implemented by the flush worker: drain dirty keys for spaces. */
export const FLUSH_HANDLER = Symbol('FlushHandler');

export interface FlushHandler {
  /**
   * Flush the given spaces. Returns the ids still needing a flush
   * (lock contention etc.) — the scheduler retains and retries them.
   * Throwing retains the whole batch. Never blocks: busy resources are
   * reported, not waited on.
   */
  handle(spaceIds: string[]): Promise<string[]>;
}

/**
 * Locking for paths outside the flush publish (write pre-lock, read
 * locks). Locks live on the storage medium (adapter lock resources), so
 * other Global Storage instances can see them. Held pre-locks are
 * consumed by the flush worker, which adopts them. Dict-first ordering
 * applies to every acquisition: the dictionary lock is always taken
 * before resolving and acquiring a block lock, so acquisitions are
 * never spent on stale mappings.
 */
export const BLOCK_LOCKS = Symbol('BlockLocks');

export interface BlockLockPort {
  /** Resolve a key to its current block via the dictionary, if known. */
  locateKeyBlock(spaceId: string, key: string): Promise<string | null>;
  /**
   * Acquire the dictionary lock (short lease: covers one
   * resolve-and-acquire round). Returns the fencing token, null when busy.
   */
  acquireDictionary(spaceId: string, owner: string, leaseMs: number): Promise<string | null>;
  /**
   * Acquire the block lock. Returns the fencing token on success,
   * null when the block is already locked (caller proceeds anyway).
   */
  tryAcquire(
    spaceId: string,
    blockId: string,
    owner: string,
    leaseMs: number,
  ): Promise<string | null>;
  release(spaceId: string, blockId: string, owner: string): Promise<void>;
}
