import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { DatabaseHealthIndicator } from './database-health.indicator';
import { DependencyHealthIndicator } from './dependency-health.indicator';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';

class HealthResponse {
  @ApiProperty({ enum: ['ok', 'error'] }) status!: string;
  @ApiProperty({ type: Object, additionalProperties: true }) info!: Record<string, unknown>;
  @ApiPropertyOptional({ type: Object, additionalProperties: true }) error?: Record<string, unknown>;
  @ApiProperty({ type: Object, additionalProperties: true }) details!: Record<string, unknown>;
}
@Controller('health')
@ApiTags('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly database: DatabaseHealthIndicator,
    private readonly dependencies: DependencyHealthIndicator,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Check service health' })
  @ApiOkResponse({ description: 'All configured dependencies are healthy', type: HealthResponse })
  check() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 256 * 1024 * 1024),
      () => this.database.ping('database'),
      () =>
        this.dependencies.redis(
          'redis_cache',
          this.config.get('cache.provider', { infer: true }),
          this.config.get('cache.redisUrl', { infer: true }),
        ),
      () =>
        this.dependencies.redis(
          'redis_queue',
          this.config.get('queue.provider', { infer: true }),
          this.config.get('queue.redisUrl', { infer: true }),
        ),
      () => this.dependencies.storage(),
      () => this.dependencies.mail(),
    ]);
  }
}
