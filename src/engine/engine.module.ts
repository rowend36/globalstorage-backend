import { Module } from '@nestjs/common';
import { StorageEngineService } from './engine.service';
import { FlushScheduler } from './flush-scheduler';

/**
 * Operational key-value engine. No flush handler or lock provider is
 * registered here — Phase 3 adds them. Until then, writes commit locally
 * and stay pending, and pre-locking is skipped.
 */
@Module({
  providers: [StorageEngineService, FlushScheduler],
  exports: [StorageEngineService, FlushScheduler],
})
export class EngineModule {}
