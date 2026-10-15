import { AuditService } from './audit.service';

describe('AuditService', () => {
  const em = {
    find: jest.fn(),
    create: jest.fn(),
    flush: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    em.flush.mockResolvedValue(undefined);
  });

  it('uses the explicit tenant scope when provided', async () => {
    await expect(new AuditService(em as never).scopeForActor('user-1', 'tenant-1')).resolves.toBe('tenant-1');
    expect(em.find).not.toHaveBeenCalled();
  });

  it('uses the platform tenant for a platform actor', async () => {
    em.find.mockResolvedValue([
      {
        tenant: { id: 'platform-tenant', slug: 'platform' },
        roles: { getItems: () => [{ role: { platformRole: true } }] },
      },
    ]);
    await expect(new AuditService(em as never).scopeForActor('user-1')).resolves.toBe('platform-tenant');
  });

  it('uses a null scope for system events and customer actors without a tenant', async () => {
    await expect(new AuditService(em as never).scopeForActor()).resolves.toBeNull();
    em.find.mockResolvedValue([]);
    await expect(new AuditService(em as never).scopeForActor('user-1')).resolves.toBeNull();
  });
});
