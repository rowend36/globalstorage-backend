import { AuthService } from './auth.service';

describe('AuthService.register', () => {
  const setup = () => {
    const create = jest.fn(
      (_schema: unknown, data: Record<string, unknown>) => ({
        ...data,
        id: `${data.slug ?? 'user'}-id`,
      }),
    );
    const txEm = { create, flush: jest.fn().mockResolvedValue(undefined) };
    const em = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      transactional: jest.fn(
        (callback: (em: unknown) => Promise<unknown>) => callback(txEm),
      ),
    };
    const instance = new AuthService(
      em as never,
      {} as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    instance.login = jest.fn(async () => ({
      accessToken: 'access',
      refreshToken: 'refresh',
    }));
    return { instance, create, em };
  };

  it('creates a personal tenant with the none MFA policy and issues tokens', async () => {
    const { instance, create, em } = setup();

    const result = await instance.register('User@Example.com ', 'password123', ' Ada ');

    expect(result.tokens).toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    const tenantCall = create.mock.calls.find(
      ([, data]) => (data as { name?: string }).name === 'Personal',
    );
    expect(tenantCall).toBeDefined();
    const tenant = tenantCall![1] as Record<string, unknown>;
    expect(tenant.mfaPolicy).toBe('none');
    expect(String(tenant.slug)).toMatch(/^personal-[0-9a-f]{10}$/);
    expect((result.user as unknown as { email: string }).email).toBe('user@example.com');
    expect((result.user as unknown as { name: string }).name).toBe('Ada');
    expect(instance.login).toHaveBeenCalledWith(
      result.user,
      'personal-' + String(tenant.slug).slice('personal-'.length) + '-id',
    );
    expect(em.transactional).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate registration', async () => {
    const { instance, em } = setup();
    em.findOne.mockResolvedValue({ id: 'existing', email: 'user@example.com' });

    await expect(instance.register('user@example.com', 'password123')).rejects.toThrow(
      'Email already registered',
    );
  });

  it('skips the MFA challenge for tenants with the none policy', async () => {
    const { instance, em } = setup();
    em.findOne.mockResolvedValue({ id: 'tenant-1', slug: 'personal', mfaPolicy: 'none', deletedAt: null });
    em.find.mockResolvedValue([
      {
        tenant: { id: 'tenant-1', slug: 'personal', mfaPolicy: 'none' },
        roles: { getItems: () => [] },
        deletedAt: null,
      },
    ]);

    await expect(
      instance.mfaMethodsForUser({ id: 'user-1', totpSecret: null } as never, 'personal'),
    ).resolves.toEqual({ methods: [], tenantId: 'tenant-1' });
  });
});
