import { FieldEncryptionService } from './field-encryption.service';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as never;

describe('FieldEncryptionService', () => {
  it('encrypts with the current version and decrypts retained previous versions', () => {
    const keyV1 = Buffer.alloc(32, 1).toString('base64');
    const keyV2 = Buffer.alloc(32, 2).toString('base64');
    const v1 = new FieldEncryptionService(
      config({ 'security.fieldEncryptionKeys': `v1:${keyV1}` }),
    );
    const v2 = new FieldEncryptionService(
      config({
        'security.fieldEncryptionKeys': `v1:${keyV1},v2:${keyV2}`,
        'security.fieldEncryptionCurrentVersion': 'v2',
      }),
    );

    const encryptedV1 = v1.encrypt('JBSWY3DPEHPK3PXP');
    expect(encryptedV1.startsWith('v1.')).toBe(true);
    expect(v2.decrypt(encryptedV1)).toBe('JBSWY3DPEHPK3PXP');
    expect(v2.decrypt(encryptedV1.slice(3))).toBe('JBSWY3DPEHPK3PXP');
    expect(v2.encrypt('JBSWY3DPEHPK3PXP').startsWith('v2.')).toBe(true);
  });

  it('rejects invalid key material', () => {
    expect(
      () =>
        new FieldEncryptionService(
          config({ 'security.fieldEncryptionKeys': 'v1:not-a-key' }),
        ),
    ).toThrow('must be a base64 32-byte key');
  });
});
