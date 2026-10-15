import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { uuid } from './helpers';
import { TenantMembershipSchema } from './tenant.schema';
import { AuthSessionSchema } from './auth.schema';
import { TenantSchema } from './tenant.schema';

export const UserSchema = defineEntity({
  name: 'User',
  tableName: 'users',
  properties: {
    id: uuid(),
    email: p.string().unique(),
    passwordHash: p.string().hidden(),
    totpSecret: p.string().nullable().hidden(),
    roleVersion: p.integer().default(1),
    deletedAt: p.datetime().nullable(),
    name: p.string().nullable(),
    memberships: () => p.oneToMany(TenantMembershipSchema).mappedBy('user'),
    sessions: () => p.oneToMany(AuthSessionSchema).mappedBy('user'),
    identities: () => p.oneToMany(ExternalIdentitySchema).mappedBy('user'),
  },
});
export type User = InferEntity<typeof UserSchema>;

export const ExternalIdentitySchema = defineEntity({
  name: 'ExternalIdentity',
  tableName: 'external_identities',
  indexes: [{ properties: ['user'] }, { properties: ['tenant'] }],
  properties: {
    id: uuid(),
    user: () => p.manyToOne(UserSchema),
    tenant: () => p.manyToOne(TenantSchema).nullable(),
    issuer: p.string(),
    subject: p.string(),
  },
});
export type ExternalIdentity = InferEntity<typeof ExternalIdentitySchema>;
