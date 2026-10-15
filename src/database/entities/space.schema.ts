import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { uuid } from './helpers';
import { UserSchema } from './user.schema';

export type SpaceState = 'active' | 'unhealthy';
export type SpaceBlockState = 'active' | 'retired';

export interface DictionaryEntry {
  blockId: string;
  keyVersion: number;
}

export type DictionaryEntries = Record<string, DictionaryEntry>;

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
    version: p.integer().default(1),
    value: p.blob(),
    contentType: p.string().nullable(),
    lastPersistedVersion: p.integer().default(0),
    createdAt: p.datetime().onCreate(() => new Date()),
    updatedAt: p.datetime().onUpdate(() => new Date()).nullable(),
  },
});
export type SpaceKey = InferEntity<typeof SpaceKeySchema>;

export const SpaceBlockSchema = defineEntity({
  name: 'SpaceBlock',
  tableName: 'space_blocks',
  indexes: [{ properties: ['space'] }],
  properties: {
    id: uuid(),
    space: () => p.manyToOne(SpaceSchema),
    generation: p.integer().default(1),
    sizeBytes: p.integer().default(0),
    checksum: p.string(),
    payload: p.blob(),
    state: p.string().default<SpaceBlockState>('active'),
    createdAt: p.datetime().onCreate(() => new Date()),
  },
});
export type SpaceBlock = InferEntity<typeof SpaceBlockSchema>;

export const SpaceDictionarySchema = defineEntity({
  name: 'SpaceDictionary',
  tableName: 'space_dictionaries',
  properties: {
    id: uuid(),
    space: () => p.manyToOne(SpaceSchema).unique(),
    version: p.integer().default(0),
    entries: p.json().$type<DictionaryEntries>(),
    checksum: p.string().nullable(),
    updatedAt: p.datetime().onUpdate(() => new Date()).nullable(),
  },
});
export type SpaceDictionary = InferEntity<typeof SpaceDictionarySchema>;
