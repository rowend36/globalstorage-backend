import { createHash } from 'node:crypto';

/** Target physical block size; Stage 1 proof-of-layout constant. */
export const BLOCK_TARGET_BYTES = 100 * 1024;

export interface BlockEnvelopeEntry {
  /** Committed logical version of the key stored in this block copy. */
  v: number;
  ct: string | null;
  data: string;
}

export type BlockEnvelope = Record<string, BlockEnvelopeEntry>;

const ENVELOPE_OVERHEAD_BYTES = 64;

/** Approximate storage cost of one entry inside a block envelope. */
export function estimateEntryBytes(
  key: string,
  valueBytes: number,
  contentType: string | null,
): number {
  return (
    Buffer.byteLength(key, 'utf8') +
    valueBytes +
    Buffer.byteLength(contentType ?? '', 'utf8') +
    ENVELOPE_OVERHEAD_BYTES
  );
}

/** First block (most recently used first) that fits the entry, if any. */
export function chooseBlock(
  blocks: ReadonlyArray<{ id: string; sizeBytes: number }>,
  neededBytes: number,
): string | null {
  for (const block of blocks) {
    if (block.sizeBytes + neededBytes <= BLOCK_TARGET_BYTES) return block.id;
  }
  return null;
}

export function serializeEnvelope(envelope: BlockEnvelope): Buffer {
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export function parseEnvelope(payload: Uint8Array | null | undefined): BlockEnvelope {
  if (!payload || payload.length === 0) return {};
  return JSON.parse(Buffer.from(payload).toString('utf8')) as BlockEnvelope;
}

export function encodeValue(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

export function decodeValue(data: string): Buffer {
  return Buffer.from(data, 'base64');
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function sortedEntries(
  entries: Record<string, { blockId: string; keyVersion: number }>,
): Record<string, { blockId: string; keyVersion: number }> {
  return Object.fromEntries(
    Object.keys(entries)
      .sort()
      .map((key) => [key, entries[key]]),
  );
}

/** Stable serialization for dictionary integrity checksums. */
export function canonicalDictionary(
  entries: Record<string, { blockId: string; keyVersion: number }>,
): string {
  return JSON.stringify(sortedEntries(entries));
}
