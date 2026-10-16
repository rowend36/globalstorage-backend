import {
  BLOCK_FORMAT,
  DICTIONARY_FORMAT,
  LOCK_FORMAT,
  StorageCorruptError,
  StorageVersionError,
  emptyDictionary,
  newBlockId,
  newFence,
  parseBlock,
  parseDictionary,
  parseLock,
  serializeBlock,
  serializeDictionary,
  serializeLock,
  sha256Hex,
} from './formats';

describe('storage formats', () => {
  it('round-trips blocks with integrity', () => {
    const block = {
      format: BLOCK_FORMAT,
      blockId: 'blk_1',
      blockVersion: 3,
      entries: {
        'todos/1': { value: Buffer.from('x').toString('base64'), keyVersion: 42, contentType: 'application/json', updatedAt: new Date(42).toISOString() },
      },
    };
    const parsed = parseBlock(serializeBlock(block));
    expect(parsed).toMatchObject({ blockId: 'blk_1', blockVersion: 3 });
    expect(parsed.entries['todos/1'].keyVersion).toBe(42);
    expect(parsed.checksum).toHaveLength(64);
  });

  it('round-trips dictionaries and locks', () => {
    const dictionary = {
      ...emptyDictionary(),
      dictionaryVersion: 7,
      entries: { 'a/1': { blockId: 'blk_1', keyVersion: 9 } },
      blocks: { blk_1: { blockVersion: 2, keyCount: 1, liveBytes: 100 } },
    };
    expect(parseDictionary(serializeDictionary(dictionary)).dictionaryVersion).toBe(7);
    const lock = {
      format: LOCK_FORMAT,
      resource: 'block/blk_1',
      owner: 'w1',
      fence: newFence(),
      leaseExpiresAt: Date.now() + 1000,
      acquiredAt: Date.now(),
    };
    expect(parseLock(serializeLock(lock)).owner).toBe('w1');
    expect(parseDictionary(serializeDictionary(emptyDictionary())).dictionaryVersion).toBe(0);
  });

  it('rejects tampered checksums', () => {
    const good = JSON.parse(serializeBlock({
      format: BLOCK_FORMAT,
      blockId: 'blk_1',
      blockVersion: 1,
      entries: {},
    }).toString('utf8')) as Record<string, unknown>;
    good.blockVersion = 2;
    expect(() => parseBlock(Buffer.from(JSON.stringify(good)))).toThrow(StorageCorruptError);
  });

  it('fails explicitly on higher format versions', () => {
    const future = { format: 'gs-dict/2', dictionaryVersion: 1, entries: {}, blocks: {}, checksum: 'x' };
    expect(() => parseDictionary(Buffer.from(JSON.stringify(future)))).toThrow(
      StorageVersionError,
    );
    expect(() => parseDictionary(Buffer.from('not json'))).toThrow(StorageCorruptError);
    expect(() => parseDictionary(Buffer.from(JSON.stringify({ nope: 1 })))).toThrow(
      StorageCorruptError,
    );
  });

  it('generates unique ids and stable hashes', () => {
    expect(newBlockId()).not.toBe(newBlockId());
    expect(newBlockId().startsWith('blk_')).toBe(true);
    expect(sha256Hex(Buffer.from('a'))).toBe(sha256Hex(Buffer.from('a')));
    expect(DICTIONARY_FORMAT).toBe('gs-dict/1');
  });
});
