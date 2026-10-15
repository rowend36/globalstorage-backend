import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { uuid } from './helpers';
import { UserSchema } from './user.schema';

export const AuthSessionSchema = defineEntity({
  name: 'AuthSession',
  tableName: 'auth_sessions',
  indexes: [{ properties: ['user'] }],
  properties: {
    id: uuid(),
    user: () => p.manyToOne(UserSchema),
    tenantId: p.uuid().nullable(),
    absoluteExpiresAt: p.datetime(),
    revokedAt: p.datetime().nullable(),
    revokedReason: p.string().nullable(),
    createdAt: p.datetime().onCreate(() => new Date()),
    refreshTokens: () => p.oneToMany(RefreshTokenSchema).mappedBy('session'),
  },
});
export type AuthSession = InferEntity<typeof AuthSessionSchema>;

export const RefreshTokenSchema = defineEntity({
  name: 'RefreshToken',
  tableName: 'refresh_tokens',
  properties: {
    id: uuid(),
    session: () => p.manyToOne(AuthSessionSchema),
    tokenHash: p.string().unique(),
    expiresAt: p.datetime(),
    usedAt: p.datetime().nullable(),
    revokedAt: p.datetime().nullable(),
    replacedById: p.uuid().nullable(),
    createdAt: p.datetime().onCreate(() => new Date()),
  },
});
export type RefreshToken = InferEntity<typeof RefreshTokenSchema>;

export const PasswordResetTokenSchema = defineEntity({
  name: 'PasswordResetToken',
  tableName: 'password_reset_tokens',
  indexes: [{ properties: ['user'] }],
  properties: {
    id: uuid(),
    user: () => p.manyToOne(UserSchema),
    tokenHash: p.string().unique(),
    expiresAt: p.datetime(),
    usedAt: p.datetime().nullable(),
    createdAt: p.datetime().onCreate(() => new Date()),
  },
});
export type PasswordResetToken = InferEntity<typeof PasswordResetTokenSchema>;
