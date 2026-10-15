import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { SchemaGenerator, SqliteDriver } from '@mikro-orm/sqlite';
import { Migrator, TSMigrationGenerator } from '@mikro-orm/migrations';
import { join } from 'node:path';
import { AppConfig } from '../config/configuration';
import {
  AuditEventSchema,
  AuthSessionSchema,
  ExternalIdentitySchema,
  MembershipRoleSchema,
  PasswordResetTokenSchema,
  RefreshTokenSchema,
  RoleSchema,
  SpaceBlockSchema,
  SpaceDictionarySchema,
  SpaceKeySchema,
  SpaceSchema,
  TenantMembershipSchema,
  TenantOidcConfigSchema,
  TenantSchema,
  UserSchema,
} from './entities';

export const mikroOrmOptions = (config: Pick<AppConfig, 'database'>) => ({
  driver:
    config.database.driver === 'postgresql' ? PostgreSqlDriver : SqliteDriver,
  ...(config.database.driver === 'postgresql'
    ? {
        host: config.database.postgres.host,
        port: config.database.postgres.port,
        user: config.database.postgres.user,
        password: config.database.postgres.password,
        dbName: config.database.postgres.database,
      }
    : { dbName: config.database.sqlite.path }),

  entities: [
    UserSchema,
    ExternalIdentitySchema,
    TenantSchema,
    TenantMembershipSchema,
    TenantOidcConfigSchema,
    RoleSchema,
    MembershipRoleSchema,
    AuthSessionSchema,
    RefreshTokenSchema,
    PasswordResetTokenSchema,
    AuditEventSchema,
    SpaceSchema,
    SpaceKeySchema,
    SpaceBlockSchema,
    SpaceDictionarySchema,
  ] as any[],
  extensions: [Migrator, SchemaGenerator],
  migrations: {
    path: join(
      __dirname,
      'migrations',
      config.database.driver === 'postgresql' ? 'postgresql' : 'sqlite',
    ),
    pathTs: join(
      process.cwd(),
      'src/database/migrations',
      config.database.driver === 'postgresql' ? 'postgresql' : 'sqlite',
    ),
    generator: TSMigrationGenerator,
    snapshotName: 'snapshot',
  },
  schemaGenerator: {
    ignoreTriggers: false,
  },
});
