import { AuthorizationVersionService } from './authorization-version.service';

describe('AuthorizationVersionService', () => {
  const em = {
    findOne: jest.fn(),
    persist: jest.fn(),
    flush: jest.fn(),
    fork: jest.fn(),
  };
  const cache = { del: jest.fn() };
  const service = () => new AuthorizationVersionService(em as never, cache as never);

  beforeEach(() => {
    jest.clearAllMocks();
    em.flush.mockResolvedValue(undefined);
    em.fork.mockReturnValue(em);
  });

  it('increments the user role version and invalidates its cache', async () => {
    const user = { id: 'user-1', roleVersion: 3 };
    em.findOne.mockResolvedValue(user);
    await service().membershipChanged(user.id);
    expect(user.roleVersion).toBe(4);
    expect(em.persist).toHaveBeenCalledWith(user);
    expect(cache.del).toHaveBeenCalledWith('auth:user-version:user-1');
  });

  it('increments the role version and invalidates its cache', async () => {
    const role = { id: 'role-1', version: 7 };
    em.findOne.mockResolvedValue(role);
    await service().roleClaimsChanged(role.id);
    expect(role.version).toBe(8);
    expect(em.persist).toHaveBeenCalledWith(role);
    expect(cache.del).toHaveBeenCalledWith('auth:role-version:role-1');
  });

  it('rejects version changes for missing records', async () => {
    em.findOne.mockResolvedValue(null);
    await expect(service().membershipChanged('missing')).rejects.toThrow('User not found');
    await expect(service().roleClaimsChanged('missing')).rejects.toThrow('Role not found');
  });
});
