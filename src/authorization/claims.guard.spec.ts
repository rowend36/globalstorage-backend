import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ClaimsGuard } from './claims.guard';

const user = (overrides: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  email: 'user@example.test',
  jti: 'session-1',
  userVersion: 1,
  roles: [],
  ...overrides,
});

const context = (request: unknown) => ({
  getHandler: () => 'handler',
  getClass: () => 'class',
  switchToHttp: () => ({ getRequest: () => request }),
}) as never;

describe('ClaimsGuard', () => {
  const reflector = { getAllAndOverride: jest.fn() };
  const em = { findOne: jest.fn() };
  const config = { get: jest.fn() };
  const guard = () => new ClaimsGuard(reflector as never, em as never, config as never);

  beforeEach(() => {
    jest.clearAllMocks();
    reflector.getAllAndOverride.mockReturnValue(['records:read']);
    config.get.mockReturnValue(false);
    em.findOne.mockResolvedValue({ id: 'tenant-1', path: 'root.child' });
  });

  it('allows requests without required claims metadata', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    await expect(guard().canActivate(context({}))).resolves.toBe(true);
    expect(em.findOne).not.toHaveBeenCalled();
  });

  it('rejects a protected request without an authenticated user', async () => {
    await expect(guard().canActivate(context({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows a matching platform claim globally', async () => {
    const request = { user: user({ roles: [{ platformClaims: ['records:read'] }] }), headers: {} };
    await expect(guard().canActivate(context(request))).resolves.toBe(true);
    expect(em.findOne).not.toHaveBeenCalled();
  });

  it('allows wildcard platform access only when superuser claims are enabled', async () => {
    config.get.mockReturnValue(true);
    const request = { user: user({ roles: [{ platformClaims: ['*'] }] }), headers: {} };
    await expect(guard().canActivate(context(request))).resolves.toBe(true);
  });

  it('requires tenant context for tenant-scoped claims', async () => {
    const request = { user: user(), headers: {} };
    await expect(guard().canActivate(context(request))).rejects.toThrow('x-tenant-id is required');
  });

  it('allows a direct tenant claim', async () => {
    const request = {
      user: user({ roles: [{ tenantId: 'tenant-1', tenantPath: 'root', includeDescendants: false, claims: ['records:read'] }] }),
      headers: { 'x-tenant-id': 'tenant-1' },
    };
    await expect(guard().canActivate(context(request))).resolves.toBe(true);
  });

  it('allows a descendant claim when the role includes descendants', async () => {
    const request = {
      user: user({ roles: [{ tenantId: 'root', tenantPath: 'root', includeDescendants: true, claims: ['records:read'] }] }),
      headers: { 'x-tenant-id': 'tenant-1' },
    };
    await expect(guard().canActivate(context(request))).resolves.toBe(true);
  });

  it('rejects an unknown tenant and missing claims', async () => {
    em.findOne.mockResolvedValueOnce(null);
    await expect(guard().canActivate(context({ user: user(), headers: { 'x-tenant-id': 'missing' } }))).rejects.toBeInstanceOf(ForbiddenException);

    em.findOne.mockResolvedValue({ id: 'tenant-1', path: 'root.child' });
    await expect(guard().canActivate(context({ user: user(), headers: { 'x-tenant-id': 'tenant-1' } }))).rejects.toThrow('Missing required claim');
  });
});
