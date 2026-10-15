import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { uuid } from './helpers';
import { UserSchema } from './user.schema';

export type TenantMfaPolicy = 'any' | 'totp' | 'email';

export const TenantSchema = defineEntity({
  name: 'Tenant',
  tableName: 'tenants',
  indexes: [{ properties: ['parent'] }],
  properties: {
    id: uuid(),
    slug: p.string().unique(),
    name: p.string(),
    path: p.string().unique(),
    mfaPolicy: p.string().default('any'),
    parent: () => p.manyToOne(TenantSchema).nullable(),
    children: () => p.oneToMany(TenantSchema).mappedBy('parent'),
    memberships: () => p.oneToMany(TenantMembershipSchema).mappedBy('tenant'),
    oidcConfigs: () => p.oneToMany(TenantOidcConfigSchema).mappedBy('tenant'),
    deletedAt: p.datetime().nullable(),
  },
});
export type Tenant = InferEntity<typeof TenantSchema>;

export const TenantOidcConfigSchema = defineEntity({
  name: 'TenantOidcConfig',
  tableName: 'tenant_oidc_configs',
  indexes: [{ properties: ['tenant'] }],
  properties: {
    id: uuid(),
    tenant: () => p.manyToOne(TenantSchema),
    issuer: p.string(),
    clientId: p.string(),
    clientSecret: p.string().hidden(),
    membershipClaim: p.string().nullable(),
    membershipValue: p.string().nullable(),
    allowedEmailDomain: p.string().nullable(),
    enabled: p.boolean().default(true),
  },
});
export type TenantOidcConfig = InferEntity<typeof TenantOidcConfigSchema>;

export const RoleSchema = defineEntity({
  name: 'Role',
  tableName: 'roles',
  properties: {
    id: uuid(),
    name: p.string().unique(),
    claims: p.string().array(),
    platformRole: p.boolean().default(false),
    version: p.integer().default(1),
    assignments: () => p.oneToMany(MembershipRoleSchema).mappedBy('role'),
  },
});
export type Role = InferEntity<typeof RoleSchema>;

export const TenantMembershipSchema = defineEntity({
  name: 'TenantMembership',
  tableName: 'tenant_memberships',
  indexes: [{ properties: ['user'] }, { properties: ['tenant'] }],
  properties: {
    id: uuid(),
    user: () => p.manyToOne(UserSchema),
    tenant: () => p.manyToOne(TenantSchema),
    includeDescendants: p.boolean().default(false),
    roles: () => p.oneToMany(MembershipRoleSchema).mappedBy('membership'),
    deletedAt: p.datetime().nullable(),
  },
});
export type TenantMembership = InferEntity<typeof TenantMembershipSchema>;

export const MembershipRoleSchema = defineEntity({
  name: 'MembershipRole',
  tableName: 'membership_roles',
  indexes: [{ properties: ['membership'] }, { properties: ['role'] }],
  properties: {
    id: uuid(),
    membership: () => p.manyToOne(TenantMembershipSchema),
    role: () => p.manyToOne(RoleSchema),
  },
});
export type MembershipRole = InferEntity<typeof MembershipRoleSchema>;
