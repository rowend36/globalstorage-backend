import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createKeyv } from 'cacheable';
import { createKeyv as createKeyvRedis } from '@keyv/redis';
import { AuthModule } from './auth/auth.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { AppConfig, configuration } from './config/configuration';
import { mikroOrmOptions } from './database/mikro-orm.config';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { SecurityModule } from './security/security.module';
import { StorageModule } from './storage/storage.module';
import { MailModule } from './mail/mail.module';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import {
  RATE_LIMIT_STORAGE,
  type RateLimitPort,
} from './infrastructure/rate-limit.port';
import { OidcModule } from './oidc/oidc.module';
import { JobsModule } from './jobs/jobs.module';
import { EngineModule } from './engine/engine.module';
import { SpacesModule } from './spaces/spaces.module';
import { LoggerModule } from 'nestjs-pino';
import pino, { type TransportTargetOptions } from 'pino';
import { join } from 'node:path';
import { requestContext } from './infrastructure/request-context';
import { ObservabilityModule } from './observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const logging = config.get('logging', { infer: true });
        const { level, filePath, pretty, loki } = logging;
        const stdoutLevel = filePath && !pretty ? 'warn' : 'info';

        const targets: TransportTargetOptions[] = [
          pretty
            ? {
                target: require.resolve('pino-pretty'),
                options: {
                  colorize: true,
                  translateTime: 'HH:MM:ss',
                  ignore: 'pid,hostname',
                },
                level: stdoutLevel,
              }
            : {
                target: 'pino/file',
                options: { destination: 1 },
                level: stdoutLevel,
              },
        ];

        if (filePath) {
          targets.push({
            target: 'pino/file',
            options: {
              destination: join(process.cwd(), filePath),
              mkdir: true,
            },
            level: 'info',
          });
        }

        if (loki.url) {
          targets.push({
            target: require.resolve('pino-loki'),
            options: {
              host: loki.url,
              labels: loki.labels,
              structuredMetaKey: 'meta',
              batching: { interval: 3 },
              timeout: 30_000,
              ...(loki.username && loki.password
                ? {
                    basicAuth: {
                      username: loki.username,
                      password: loki.password,
                    },
                  }
                : {}),
              ...(loki.orgId
                ? { headers: { 'X-Scope-OrgID': loki.orgId } }
                : {}),
            },
            level: 'info',
          });
        }

        const stream =
          filePath || pretty || loki.url ? pino.transport({ targets }) : undefined;
        return {
          pinoHttp: {
            level,
            ...(stream ? { stream } : {}),
            customProps: () => {
              const context = requestContext.getStore();
              return {
                correlationId: context?.correlationId,
                userId: context?.userId,
                tenantId: context?.tenantId,
              };
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.newPassword',
                'req.body.token',
                'req.body.refreshToken',
                'res.body',
              ],
              censor: '[REDACTED]',
            },
          },
        };
      },
    }),
    MikroOrmModule.forRootAsync({
      driver:
        process.env.DATABASE_DRIVER === 'postgresql'
          ? PostgreSqlDriver
          : SqliteDriver,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        mikroOrmOptions({
          database: config.get('database', { infer: true }),
        }),
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const provider = config.get('cache.provider', { infer: true });
        const redisUrl = config.get('cache.redisUrl', { infer: true });
        return provider === 'redis' && redisUrl
          ? { stores: [createKeyvRedis(redisUrl)] }
          : { stores: [createKeyv({ ttl: 60_000, lruSize: 1000 })] };
      },
    }),
    InfrastructureModule,
    ThrottlerModule.forRootAsync({
      imports: [InfrastructureModule],
      inject: [RATE_LIMIT_STORAGE],
      useFactory: (storage: RateLimitPort) => ({
        throttlers: [{ ttl: 60_000, limit: 100, blockDuration: 60_000 }],
        storage,
      }),
    }),
    AuthModule,
    AuditModule,
    SecurityModule,
    StorageModule,
    MailModule,
    OidcModule,
    AuthorizationModule,
    HealthModule,
    JobsModule.register(),
    ObservabilityModule,
    EngineModule,
    SpacesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
