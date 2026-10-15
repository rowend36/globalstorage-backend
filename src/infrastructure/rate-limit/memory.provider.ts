import { Injectable } from '@nestjs/common';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type { RateLimitPort } from '../rate-limit.port';

@Injectable()
export class MemoryRateLimitProvider implements RateLimitPort {
  private readonly memory = new Map<
    string,
    { hits: number; expiresAt: number; blockedUntil: number }
  >();

  // eslint-disable-next-line @typescript-eslint/require-await
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const entry = this.memory.get(key) ?? {
      hits: 0,
      expiresAt: now + ttl,
      blockedUntil: 0,
    };
    if (entry.expiresAt <= now) {
      entry.hits = 0;
      entry.expiresAt = now + ttl;
      entry.blockedUntil = 0;
    }
    entry.hits += 1;
    if (entry.hits > limit) {
      entry.blockedUntil = Math.max(entry.blockedUntil, now + blockDuration);
    }
    this.memory.set(key, entry);
    return {
      totalHits: entry.hits,
      timeToExpire: Math.max(0, entry.expiresAt - now),
      isBlocked: entry.blockedUntil > now,
      timeToBlockExpire: Math.max(0, entry.blockedUntil - now),
    };
  }
}
