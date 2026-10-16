import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import type { FlushHandler } from './ports';

/**
 * Debounced flush scheduling. Writes only mark spaces dirty; this batches
 * them so one flush cycle drains everything written within the window.
 * The flush worker registers itself via registerHandler (NOT via DI: the
 * worker transitively needs the scheduler, so injecting the handler here
 * would be an unresolvable resolution cycle that hangs Nest silently).
 * With no handler, batches are retained and warned about — never dropped.
 */
@Injectable()
export class FlushScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(FlushScheduler.name);
  private readonly pending = new Set<string>();
  private handler?: FlushHandler;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  registerHandler(handler: FlushHandler): void {
    this.handler = handler;
  }

  unregisterHandler(): void {
    this.handler = undefined;
  }

  schedule(spaceId: string): void {
    this.pending.add(spaceId);
    this.arm();
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
      const remaining = (await this.handler.handle(batch)) ?? batch;
      for (const spaceId of remaining) this.pending.add(spaceId);
    } catch (error) {
      this.logger.error(
        `Flush handler failed for ${batch.length} space(s); retaining for retry`,
        error instanceof Error ? error.stack : undefined,
      );
      batch.forEach((spaceId) => this.pending.add(spaceId));
    }
    // Anything still pending (reported backpressure or failure) retries
    // on the debounce cadence without needing new writes.
    if (this.pending.size > 0) this.arm();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const debounceMs = this.config.get('persistence', { infer: true }).flushDebounceMs;
    this.timer = setTimeout(() => void this.drain(), debounceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}
