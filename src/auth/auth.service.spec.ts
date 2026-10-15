import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';

describe('AuthService email MFA', () => {
  const cache = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
  const mfa = { sendEmailCode: jest.fn() };
  const jwt = {
    sign: jest.fn(() => 'email-mfa-token'),
    verify: jest.fn(() => ({ sub: 'user-1', purpose: 'mfa-email', jti: 'challenge-1' })),
  };
  const config = { get: jest.fn(() => 'jwt-secret') };
  const em = { findOne: jest.fn(), find: jest.fn() };

  const service = () => {
    const instance = new AuthService(
      em as never,
      jwt as never,
      config as never,
      cache as never,
      mfa as never,
      {} as never,
      {} as never,
      {} as never,
    );
    instance.login = jest.fn(async () => ({ accessToken: 'access', refreshToken: 'refresh' }));
    return instance;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    cache.set.mockResolvedValue(undefined);
    cache.del.mockResolvedValue(undefined);
    mfa.sendEmailCode.mockResolvedValue(undefined);
    em.findOne.mockResolvedValue({ id: 'user-1', email: 'user@example.test', deletedAt: null });
  });

  it('sends a code and verifies it once', async () => {
    const instance = service();
    const token = await instance.beginEmailMfa({
      id: 'user-1',
      email: 'user@example.test',
    } as never);
    const code = mfa.sendEmailCode.mock.calls[0][1] as string;
    const challenge = cache.set.mock.calls[0][1] as { userId: string; codeHash: string };
    cache.get.mockResolvedValue(challenge);

    await expect(instance.authenticateWithEmailMfa(token, code)).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(challenge.codeHash).toBe(createHash('sha256').update(code).digest('base64url'));
    expect(cache.del).toHaveBeenCalledWith(expect.stringContaining('mfa:email:'));
  });

  it('rejects an invalid code and consumes the challenge', async () => {
    const instance = service();
    cache.get.mockResolvedValue({ userId: 'user-1', codeHash: 'different' });

    await expect(instance.authenticateWithEmailMfa('email-mfa-token', '000000')).rejects.toThrow(
      'Invalid MFA code',
    );
    expect(cache.del).toHaveBeenCalledWith('mfa:email:challenge-1');
    expect(instance.login).not.toHaveBeenCalled();
  });

  it('returns only the method mandated by the selected tenant', async () => {
    const instance = service();
    // The mock intentionally supports keyed ConfigService lookups in this test.
    // @ts-expect-error Test-specific mock signature is broader than the inferred mock type.
    config.get.mockImplementation((key: string) =>
      key === 'auth.emailMfaEnabled' ? true : 'jwt-secret',
    );
    em.find.mockResolvedValue([
      { tenant: { id: 'tenant-1', slug: 'workspace', mfaPolicy: 'email' }, roles: { getItems: () => [] }, deletedAt: null },
    ]);
    em.findOne.mockResolvedValue({ id: 'tenant-1', slug: 'workspace', mfaPolicy: 'email', deletedAt: null });

    await expect(
      instance.mfaMethodsForUser(
        { id: 'user-1', totpSecret: 'encrypted-secret' } as never,
        'workspace',
      ),
    ).resolves.toEqual({ methods: ['email'], tenantId: 'tenant-1' });
  });

  it('requires tenant context when memberships have conflicting policies', async () => {
    const instance = service();
    em.find.mockResolvedValue([
      { tenant: { slug: 'totp-workspace', name: 'TOTP Workspace', mfaPolicy: 'totp' }, roles: { getItems: () => [] }, deletedAt: null },
      { tenant: { slug: 'email-workspace', name: 'Email Workspace', mfaPolicy: 'email' }, roles: { getItems: () => [] }, deletedAt: null },
    ]);

    await expect(instance.mfaMethodsForUser({ id: 'user-1' } as never)).resolves.toEqual({
      methods: [],
      requiresTenant: true,
      tenants: [
        { tenant: 'totp-workspace', label: 'TOTP Workspace' },
        { tenant: 'email-workspace', label: 'Email Workspace' },
      ],
    });
  });
});
