import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  MembershipRoleSchema,
  RoleSchema,
  TenantMembershipSchema,
} from '../database/entities/schemas';
import { AuthorizationVersionService } from './authorization-version.service';

@Injectable()
export class TenantAccessAdminService {
  constructor(
    private readonly em: EntityManager,
    private readonly versions: AuthorizationVersionService,
  ) {}

  async replaceRoleClaims(roleId: string, claims: string[]): Promise<void> {
    await this.em.transactional(async (transactionalEm) => {
      const role = await transactionalEm.findOne(RoleSchema, roleId);
      if (!role) throw new NotFoundException('Role not found');
      role.claims = [...new Set(claims)].sort();
      transactionalEm.persist(role);
      await this.versions.roleClaimsChanged(roleId, transactionalEm);
    });
  }

  async replaceMembershipRoles(
    membershipId: string,
    roleIds: string[],
  ): Promise<void> {
    await this.em.transactional(async (transactionalEm) => {
      const membership = await transactionalEm.findOne(
        TenantMembershipSchema,
        membershipId,
        { populate: ['user'] },
      );
      if (!membership) throw new NotFoundException('Membership not found');
      const roles = await transactionalEm.find(RoleSchema, {
        id: { $in: [...new Set(roleIds)] },
      });
      if (roles.length !== new Set(roleIds).size)
        throw new NotFoundException('One or more roles were not found');
      await transactionalEm.nativeDelete(MembershipRoleSchema, {
        membership: membership.id,
      });
      for (const role of roles)
        transactionalEm.create(MembershipRoleSchema, { membership, role });
      await this.versions.membershipChanged(
        membership.user.id,
        transactionalEm,
      );
    });
  }
}
