import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisThrottlerStorage } from '@nestjs-redis/throttler-storage';
import { createClient } from 'redis';
import { AppConfig } from '../config/configuration';
import { BullMqQueueProvider, MemoryQueueProvider } from './queue';
import { QUEUE_PROVIDER, type QueuePort } from './queue/port';
import { MemoryRateLimitProvider } from './rate-limit';
import { RATE_LIMIT_STORAGE, type RateLimitPort } from './rate-limit/port';
import { IdempotencyService } from './idempotency.service';

@Global()
@Module({
  providers: [
    MemoryQueueProvider,
    BullMqQueueProvider,
    MemoryRateLimitProvider,
    IdempotencyService,
    {
      provide: QUEUE_PROVIDER,
      inject: [ConfigService, MemoryQueueProvider, BullMqQueueProvider],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        memory: MemoryQueueProvider,
        bull: BullMqQueueProvider,
      ): QueuePort => {
        const provider = config.get('queue.provider', { infer: true });
        if (provider === 'memory') return memory;
        if (provider === 'redis') return bull;
        throw new Error(`Unsupported queue provider: ${provider}`);
      },
    },
    {
      provide: RATE_LIMIT_STORAGE,
      inject: [ConfigService, MemoryRateLimitProvider],
      useFactory: async (
        config: ConfigService<AppConfig, true>,
        memory: MemoryRateLimitProvider,
      ): Promise<RateLimitPort> => {
        const provider = config.get('cache.provider', { infer: true });
        if (provider !== 'redis') return memory;

        const url = config.get('cache.redisUrl', { infer: true });
        if (!url)
          throw new Error(
            'REDIS_URL is required for the Redis rate-limit provider',
          );

        const client = createClient({ url });
        await client.connect();
        return new RedisThrottlerStorage(client);
      },
    },
  ],
  exports: [QUEUE_PROVIDER, RATE_LIMIT_STORAGE, IdempotencyService],
})
export class InfrastructureModule {}
