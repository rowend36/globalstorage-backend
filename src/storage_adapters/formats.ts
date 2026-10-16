import { createHash, randomUUID } from 'node:crypto';

/**
 * Versioned medium formats. Every artifact family carries a format header
 * (`gs-<kind>/<major>`), so instances can distinguish data they should
 * overwrite (lower/corrupt), fail on (higher than supported), or read.
 * Checksums cover the canonical (key-sorted) body, excluding themselves.
 */

export const BLOCK_FORMAT = 'gs-block/1';
export const DICTIONARY_FORMAT = 'gs-dict/1';
export const LOCK_FORMAT = 'gs-lock/1';

const SUPPORTED_MAJOR = 1;

export interface BlockEntry {
  /** Base64 value bytes. */
  value: string;
  /** Committed logical version (timestamp) of the key in this copy. */
  keyVersion: number;
  contentType: string | null;
  updatedAt: string;
}

export interface BlockFile {
  format: string;
  blockId: string;
  entries: Record<string, BlockEntry>;
  checksum: string;
}

export interface DictionaryEntry {
  blockId: string;
  keyVersion: number;
}

export interface BlockStats {
  keyCount: number;
  liveBytes: number;
}

export interface DictionaryFile {
  format: string;
  dictionaryVersion: number;
  entries: Record<string, DictionaryEntry>;
  blocks: Record<string, BlockStats>;
  checksum: string;
}

export interface LockFile {
  format: string;
  resource: string;
  owner: string;
  fence: string;
  leaseExpiresAt: number;
  acquiredAt: number;
}

/** Stored artifact uses a format newer than this instance supports. */
export class StorageVersionError extends Error {
  readonly code = 'storage_version';
  readonly formatVersion: string;

  constructor(formatVersion: string) {
    super(`Unsupported storage format version: ${formatVersion}`);
    this.formatVersion = formatVersion;
  }
}

/** Stored artifact fails structural or integrity checks. */
export class StorageCorruptError extends Error {
  readonly code = 'storage_corrupt';

  constructor(detail: string) {
    super(`Stored artifact failed integrity checks: ${detail}`);
  }
}

export function newBlockId(): string {
  return `blk_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newFence(): string {
  return randomUUID();
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function canonical(body: unknown): string {
  return JSON.stringify(sortKeys(body));
}

function withChecksum<T extends object>(body: T): T & { checksum: string } {
  // Strip any incoming checksum first: parse → mutate → serialize must
  // round-trip, so the checksum always covers the body alone.
  const { checksum: _ignored, ...rest } = body as Record<string, unknown>;
  return { ...rest, checksum: sha256Hex(canonical(rest)) } as T & { checksum: string };
}

function parseFormat(raw: unknown, kinds: string[]): string {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { format?: unknown }).format !== 'string') {
    throw new StorageCorruptError('missing format header');
  }
  const format = (raw as { format: string }).format;
  const match = /^(gs-[a-z]+)\/(\d+)$/.exec(format);
  if (!match || !kinds.includes(match[1])) throw new StorageCorruptError(`unknown format ${format}`);
  if (Number(match[2]) > SUPPORTED_MAJOR) throw new StorageVersionError(format);
  if (Number(match[2]) < SUPPORTED_MAJOR) throw new StorageCorruptError(`retired format ${format}`);
  return format;
}

function verifyChecksum(raw: Record<string, unknown>, kind: string): void {
  const { checksum, ...body } = raw;
  if (typeof checksum !== 'string' || checksum !== sha256Hex(canonical(body))) {
    throw new StorageCorruptError(`${kind} checksum mismatch`);
  }
}

function parseJson(data: Buffer, kind: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new StorageCorruptError(`${kind} is not an object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StorageCorruptError) throw error;
    throw new StorageCorruptError(`${kind} is not valid JSON`);
  }
}

export function serializeBlock(block: Omit<BlockFile, 'checksum'>): Buffer {
  return Buffer.from(JSON.stringify(withChecksum(block)), 'utf8');
}

export function parseBlock(data: Buffer): BlockFile {
  const raw = parseJson(data, 'block');
  parseFormat(raw, ['gs-block']);
  if (typeof raw.blockId !== 'string') {
    throw new StorageCorruptError('block identity invalid');
  }
  if (typeof raw.entries !== 'object' || raw.entries === null) {
    throw new StorageCorruptError('block entries invalid');
  }
  verifyChecksum(raw, 'block');
  return raw as unknown as BlockFile;
}

export function serializeDictionary(dictionary: Omit<DictionaryFile, 'checksum'>): Buffer {
  return Buffer.from(JSON.stringify(withChecksum(dictionary)), 'utf8');
}

export function parseDictionary(data: Buffer): DictionaryFile {
  const raw = parseJson(data, 'dictionary');
  parseFormat(raw, ['gs-dict']);
  if (typeof raw.dictionaryVersion !== 'number') {
    throw new StorageCorruptError('dictionary version invalid');
  }
  if (typeof raw.entries !== 'object' || raw.entries === null) {
    throw new StorageCorruptError('dictionary entries invalid');
  }
  if (typeof raw.blocks !== 'object' || raw.blocks === null) {
    throw new StorageCorruptError('dictionary block stats invalid');
  }
  verifyChecksum(raw, 'dictionary');
  return raw as unknown as DictionaryFile;
}

export function emptyDictionary(): Omit<DictionaryFile, 'checksum'> {
  return { format: DICTIONARY_FORMAT, dictionaryVersion: 0, entries: {}, blocks: {} };
}

export function serializeLock(lock: Omit<LockFile, 'checksum'>): Buffer {
  return Buffer.from(JSON.stringify(withChecksum(lock)), 'utf8');
}

export function parseLock(data: Buffer): LockFile {
  const raw = parseJson(data, 'lock');
  parseFormat(raw, ['gs-lock']);
  if (
    typeof raw.resource !== 'string' ||
    typeof raw.owner !== 'string' ||
    typeof raw.fence !== 'string' ||
    typeof raw.leaseExpiresAt !== 'number' ||
    typeof raw.acquiredAt !== 'number'
  ) {
    throw new StorageCorruptError('lock fields invalid');
  }
  verifyChecksum(raw, 'lock');
  return raw as unknown as LockFile;
}
