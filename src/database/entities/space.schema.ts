import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { uuid } from './helpers';
import { UserSchema } from './user.schema';

export type SpaceState = 'active' | 'unhealthy';

export const SpaceSchema = defineEntity({
  name: 'Space',
  tableName: 'spaces',
  indexes: [{ properties: ['owner'] }],
  properties: {
    id: uuid(),
    owner: () => p.manyToOne(UserSchema),
    name: p.string(),
    quotaBytes: p.integer().default(50 * 1024 * 1024),
    usedBytes: p.integer().default(0),
    providerType: p.string().default('local'),
    providerConfig: p.json().nullable(),
    state: p.string().default<SpaceState>('active'),
    createdAt: p.datetime().onCreate(() => new Date()),
    updatedAt: p.datetime().onUpdate(() => new Date()).nullable(),
  },
});
export type Space = InferEntity<typeof SpaceSchema>;

export const SpaceKeySchema = defineEntity({
  name: 'SpaceKey',
  tableName: 'space_keys',
  indexes: [{ properties: ['space'] }],
  uniques: [{ properties: ['space', 'key'] }],
  properties: {
    id: uuid(),
    space: () => p.manyToOne(SpaceSchema),
    key: p.string(),
    version: p.bigint('number').default(1),
    value: p.blob(),
    contentType: p.string().nullable(),
    lastPersistedVersion: p.bigint('number').default(0),
    deletedAt: p.datetime().nullable(),
    createdAt: p.datetime().onCreate(() => new Date()),
    updatedAt: p.datetime().onUpdate(() => new Date()).nullable(),
  },
});
export type SpaceKey = InferEntity<typeof SpaceKeySchema>;
