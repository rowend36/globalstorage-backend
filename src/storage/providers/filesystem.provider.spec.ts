import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemStorageProvider } from './filesystem.provider';

describe('FilesystemStorageProvider', () => {
  let directory: string;
  let provider: FilesystemStorageProvider;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'globalstorage-storage-'));
    provider = new FilesystemStorageProvider({
      get: jest.fn((key: string) =>
        key === 'storage.publicUrl' ? 'http://localhost:3000/uploads' : directory,
      ),
    } as never);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes, reads, reports size, and deletes objects', async () => {
    const content = new TextEncoder().encode('hello');
    const stored = await provider.put('documents/greeting.txt', content, 'text/plain');

    expect(stored).toEqual(expect.objectContaining({
      key: 'documents/greeting.txt',
      size: 5,
      contentType: 'text/plain',
    }));
    await expect(provider.read('documents/greeting.txt')).resolves.toEqual(
      expect.objectContaining({ key: 'documents/greeting.txt', size: 5 }),
    );
    await expect(provider.getUrl('documents/greeting.txt', { downloadName: 'greeting.txt' })).resolves.toBe(
      'http://localhost:3000/uploads/documents/greeting.txt?download=greeting.txt',
    );
    await expect(provider.getUrl('documents/not-created.txt')).resolves.toBe(
      'http://localhost:3000/uploads/documents/not-created.txt',
    );
    await provider.delete('documents/greeting.txt');
    await expect(provider.read('documents/greeting.txt')).rejects.toThrow('not found');
  });

  it('rejects traversal and invalid content', async () => {
    await expect(provider.put('../secret', new Uint8Array([1]), 'application/octet-stream')).rejects.toThrow(
      'Invalid storage key',
    );
    expect(() => provider.validateContent(new Uint8Array(5), 'image/png', { maxBytes: 4 })).toThrow('4-byte limit');
    expect(() => provider.validateContent(new Uint8Array(1), 'text/plain', { allowedContentTypes: ['image/png'] })).toThrow(
      'not allowed',
    );
  });
});
