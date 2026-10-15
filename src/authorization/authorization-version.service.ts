import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { RoleSchema, UserSchema } from '../database/entities/schemas';
import type { Cache } from 'cache-manager';

/** Call from the transaction that changes tenant membership/scope or role claims. */
@Injectable()
export class AuthorizationVersionService {
  constructor(
    private readonly em: EntityManager,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  async membershipChanged(
    userId: string,
    entityManager?: EntityManager,
  ): Promise<void> {
    const em = entityManager ?? this.em.fork();
    const user = await em.findOne(UserSchema, userId);
    if (!user) throw new NotFoundException('User not found');
    user.roleVersion += 1;
    em.persist(user);
    await em.flush();
    await this.cache.del(`auth:user-version:${userId}`);
  }

  async roleClaimsChanged(
    roleId: string,
    entityManager?: EntityManager,
  ): Promise<void> {
    const em = entityManager ?? this.em.fork();
    const role = await em.findOne(RoleSchema, roleId);
    if (!role) throw new NotFoundException('Role not found');
    role.version += 1;
    em.persist(role);
    await em.flush();
    await this.cache.del(`auth:role-version:${roleId}`);
  }
}
