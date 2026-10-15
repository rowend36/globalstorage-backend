jest.mock('openid-client', () => ({
  calculatePKCECodeChallenge: jest.fn(async () => 'challenge'),
  ClientSecretBasic: jest.fn((secret: string) => ({ secret })),
  discovery: jest.fn(async () => ({ issuer: 'https://idp.example.test' })),
  randomPKCECodeVerifier: jest.fn(() => 'verifier'),
  buildAuthorizationUrl: jest.fn(() => new URL('https://idp.example.test/authorize')),
  authorizationCodeGrant: jest.fn(),
}));

import { OidcService } from './oidc.service';
import { authorizationCodeGrant } from 'openid-client';

describe('OidcService', () => {
  const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const em = { findOne: jest.fn(), create: jest.fn(), persist: jest.fn(), flush: jest.fn() };
  const auth = { login: jest.fn() };
  const config = {
    get: jest.fn((key: string) =>
      key === 'oidc.redirectUri'
        ? 'https://api.example.test/v1/auth/oidc/callback'
        : 'openid profile email',
    ),
  };
  const encryption = { encrypt: jest.fn((value: string) => `encrypted:${value}`), decrypt: jest.fn((value: string) => value.replace('encrypted:', '')) };

  const service = () =>
    new OidcService(config as never, cache as never, em as never, auth as never, encryption as never);

  beforeEach(() => {
    jest.clearAllMocks();
    em.findOne.mockReset();
    em.findOne.mockResolvedValue({ id: 'user-1', email: 'person@example.test', deletedAt: null });
    auth.login.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
    em.flush.mockResolvedValue(undefined);
  });

  it('requires a configured membership rule', async () => {
    em.findOne.mockResolvedValue({ id: 'tenant-1' });
    await expect(
      service().createConfig('tenant-1', {
        issuer: 'https://idp.example.test',
        clientId: 'client',
        clientSecret: 'secret',
      }),
    ).rejects.toThrow('membership rule is required');
  });

  it('provisions a user and membership for a verified claim member', async () => {
    const tenant = { id: 'tenant-1', deletedAt: null };
    const oidc = {
      id: 'config-1',
      issuer: 'https://idp.example.test',
      clientId: 'client',
      clientSecret: 'encrypted:secret',
      membershipClaim: 'groups',
      membershipValue: 'globalstorage-users',
      allowedEmailDomain: null,
      enabled: true,
      tenant,
    };
    const user = { id: 'user-1', email: 'person@example.test', deletedAt: null };
    cache.get.mockResolvedValue({ codeVerifier: 'verifier', configId: 'config-1' });
    em.findOne
      .mockResolvedValueOnce(oidc)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    em.create.mockImplementation((_schema: unknown, value: unknown) => value);
    (authorizationCodeGrant as jest.Mock).mockResolvedValue({
      claims: () => ({
        sub: 'subject-1',
        email: user.email,
        email_verified: true,
        groups: ['globalstorage-users'],
      }),
    });

    const result = await service().login('code', 'state');

    expect(result).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    expect(em.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: user.email }),
    );
    expect(em.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenant }),
    );
    expect(em.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ issuer: oidc.issuer, subject: 'subject-1' }),
    );
  });

  it('rejects an unlinked identity outside the configured workspace', async () => {
    const oidc = {
      id: 'config-1',
      issuer: 'https://idp.example.test',
      clientId: 'client',
      clientSecret: 'encrypted:secret',
      membershipClaim: 'groups',
      membershipValue: 'globalstorage-users',
      allowedEmailDomain: null,
      enabled: true,
      tenant: { id: 'tenant-1', deletedAt: null },
    };
    cache.get.mockResolvedValue({ codeVerifier: 'verifier', configId: 'config-1' });
    em.findOne.mockResolvedValueOnce(oidc).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    (authorizationCodeGrant as jest.Mock).mockResolvedValue({
      claims: () => ({ sub: 'subject-1', email: 'person@example.test', email_verified: true, groups: ['other'] }),
    });

    await expect(service().login('code', 'state')).rejects.toThrow('not a member');
    expect(em.create).not.toHaveBeenCalled();
  });

  it('allows an already linked identity without reprovisioning', async () => {
    const user = { id: 'user-1', deletedAt: null };
    cache.get.mockResolvedValue({ codeVerifier: 'verifier', configId: 'config-1' });
    em.findOne.mockResolvedValueOnce({
      id: 'config-1', issuer: 'https://idp.example.test', clientId: 'client', clientSecret: 'encrypted:secret',
      membershipClaim: 'groups', membershipValue: 'globalstorage-users', allowedEmailDomain: null, enabled: true,
      tenant: { id: 'tenant-1', deletedAt: null },
    }).mockResolvedValueOnce({ user }).mockResolvedValueOnce({ id: 'membership-1' });
    (authorizationCodeGrant as jest.Mock).mockResolvedValue({ claims: () => ({ sub: 'subject-1' }) });

    await service().login('code', 'state');

    expect(auth.login).toHaveBeenCalledWith(user, 'tenant-1');
    expect(em.create).not.toHaveBeenCalled();
  });
});
