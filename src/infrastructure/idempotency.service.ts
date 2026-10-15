import { ConflictException, Injectable } from '@nestjs/common';

/**
 * Back this interface with a UNIQUE(tenant_id, idempotency_key) DB table
 * before exposing payment endpoints.
 */
@Injectable()
export class IdempotencyService {
  private readonly results = new Map<string, unknown>();

  async execute<T>(
    tenantId: string,
    key: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!key) throw new ConflictException('Idempotency-Key is required');
    const cacheKey = `${tenantId}:${key}`;
    if (this.results.has(cacheKey)) return this.results.get(cacheKey) as T;
    const result = await work();
    this.results.set(cacheKey, result);
    return result;
  }
}
