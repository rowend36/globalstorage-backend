import type { ThrottlerStorage } from '@nestjs/throttler';

export const RATE_LIMIT_STORAGE = Symbol('RATE_LIMIT_STORAGE');
export type RateLimitPort = ThrottlerStorage;
