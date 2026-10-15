import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import { FLUSH_HANDLER, type FlushHandler } from './ports';

/**
 * Debounced flush scheduling. Writes only mark spaces dirty; this batches
 * them so one flush cycle drains everything written within the window.
 * Dispatches to the registered FlushHandler (Phase 3 worker). With no
 * handler, batches are retained and warned about — never dropped.
 */
@Injectable()
export class FlushScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(FlushScheduler.name);
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Optional() @Inject(FLUSH_HANDLER) private readonly handler?: FlushHandler,
  ) {}

  schedule(spaceId: string): void {
    this.pending.add(spaceId);
    if (this.timer) clearTimeout(this.timer);
    const debounceMs = this.config.get('persistence', { infer: true }).flushDebounceMs;
    this.timer = setTimeout(() => void this.drain(), debounceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  cancel(spaceId: string): void {
    this.pending.delete(spaceId);
  }

  pendingSpaces(): string[] {
    return [...this.pending];
  }

  async drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const batch = [...this.pending];
    this.pending.clear();
    if (!this.handler) {
      this.logger.warn(
        `No flush handler registered; retaining ${batch.length} pending space(s)`,
      );
      batch.forEach((spaceId) => this.pending.add(spaceId));
      return;
    }
    try {
      await this.handler.handle(batch);
    } catch (error) {
      this.logger.error(
        `Flush handler failed for ${batch.length} space(s); retaining for retry`,
        error instanceof Error ? error.stack : undefined,
      );
      batch.forEach((spaceId) => this.pending.add(spaceId));
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
