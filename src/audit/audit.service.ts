import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import {
  AuditEventSchema,
  TenantMembershipSchema,
  type AuditEvent,
} from '../database/entities/schemas';
import { PLATFORM_TENANT_SLUG } from '../authorization/platform.constants';

@Injectable()
export class AuditService {
  constructor(private readonly em: EntityManager) {}

  async scopeForActor(actorId?: string, tenantId?: string): Promise<string | null> {
    if (tenantId) return tenantId;
    if (!actorId) return null;
    const memberships = await this.em.find(
      TenantMembershipSchema,
      { user: actorId, deletedAt: null },
      { populate: ['tenant', 'roles.role'] },
    );
    const platformMembership = memberships.find(
      (membership) =>
        membership.tenant.slug === PLATFORM_TENANT_SLUG &&
        membership.roles.getItems().some((assignment) => assignment.role.platformRole),
    );
    return platformMembership?.tenant.id ?? null;
  }

  /** Append-only writer. DB permissions must deny UPDATE/DELETE to the application audit role. */
  async record(event: Omit<AuditEvent, 'id' | 'occurredAt'>): Promise<void> {
    this.em.create(AuditEventSchema, event);
    await this.em.flush();
  }
}
