import { TenantAccessAdminService } from './tenant-access-admin.service';

describe('TenantAccessAdminService', () => {
  const em = {
    transactional: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    persist: jest.fn(),
    nativeDelete: jest.fn(),
    create: jest.fn(),
  };
  const versions = {
    roleClaimsChanged: jest.fn(),
    membershipChanged: jest.fn(),
  };
  const service = () => new TenantAccessAdminService(em as never, versions as never);

  beforeEach(() => {
    jest.clearAllMocks();
    em.transactional.mockImplementation(async (callback: (manager: typeof em) => Promise<void>) => callback(em));
    em.findOne.mockResolvedValue({ id: 'membership-1', user: { id: 'user-1' } });
    em.find.mockResolvedValue([{ id: 'role-1' }, { id: 'role-2' }]);
  });

  it('deduplicates and sorts replacement role claims', async () => {
    await service().replaceRoleClaims('role-1', ['records:write', 'records:read', 'records:write']);
    expect(em.persist).toHaveBeenCalledWith(
      expect.objectContaining({ claims: ['records:read', 'records:write'] }),
    );
    expect(versions.roleClaimsChanged).toHaveBeenCalledWith('role-1', em);
  });

  it('replaces membership roles and increments the user version', async () => {
    await service().replaceMembershipRoles('membership-1', ['role-2', 'role-1', 'role-2']);
    expect(em.nativeDelete).toHaveBeenCalled();
    expect(em.create).toHaveBeenCalledTimes(2);
    expect(versions.membershipChanged).toHaveBeenCalledWith('user-1', em);
  });

  it('rejects membership role replacement when a role is missing', async () => {
    em.find.mockResolvedValue([{ id: 'role-1' }]);
    await expect(service().replaceMembershipRoles('membership-1', ['role-1', 'missing'])).rejects.toThrow(
      'One or more roles were not found',
    );
    expect(em.nativeDelete).not.toHaveBeenCalled();
  });
});
