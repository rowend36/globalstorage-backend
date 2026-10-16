/**
 * Storage-adapter port. Adapters persist opaque resources (blocks, the
 * dictionary, locks) to user-controlled storage behind this interface.
 * The engine never assumes a provider's native model: spaces map to a
 * prefix, resources to namespaced keys within it.
 *
 * Resource keys (Stage 1 layout):
 * - `blocks/<blockId>` — packed key-value block
 * - `dictionary` — key-to-block mapping + block stats
 * - `locks/<resource>` — lock resources (`dictionary`, `block/<id>`)
 */

export const STORAGE_ADAPTER = Symbol('StorageAdapter');

export interface StorageCapabilities {
  /** Packing target for blocks; configurable per storage type. */
  targetBlockBytes: number;
  /** Whether conditional writes are enforced by the medium. */
  conditionalWrites: boolean;
}

export interface StorageWriteOptions {
  /** Create-only: fail if the resource already exists (lock acquisition). */
  ifNoneMatch?: boolean;
  /** Fail unless the current content etag matches (fenced publish). */
  ifMatch?: string;
}

export interface StorageWriteResult {
  /** Content hash of the written bytes (sha256 hex). */
  etag: string;
}

export interface StorageAdapter {
  read(spaceId: string, resourceKey: string): Promise<Buffer | null>;
  write(
    spaceId: string,
    resourceKey: string,
    data: Buffer,
    options?: StorageWriteOptions,
  ): Promise<StorageWriteResult>;
  /** Idempotent: deleting a missing resource succeeds. */
  delete(spaceId: string, resourceKey: string): Promise<void>;
  /** Resource keys under a prefix (`''` = all), sorted. Needed for space purges and recovery scans. */
  list(spaceId: string, prefix: string): Promise<string[]>;
  getCapabilities(): StorageCapabilities;
}

/** A conditional write lost its race (create-only on existing, etag mismatch). */
export class StorageConflictError extends Error {
  readonly code = 'storage_conflict';

  constructor(resourceKey: string) {
    super(`Storage precondition failed for ${resourceKey}`);
  }
}
