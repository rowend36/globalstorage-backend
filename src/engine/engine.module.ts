import { Module } from '@nestjs/common';
import { StorageEngineService } from './engine.service';
import { FlushScheduler } from './flush-scheduler';
import { BLOCK_LOCKS, FLUSH_HANDLER } from './ports';
import { BlockManager } from '../storage/block-manager';
import { DictionaryCache } from '../storage/dictionary-cache';
import { FlushWorker } from '../storage/flush-worker';
import { LocalFilesystemAdapter } from '../storage/local-filesystem.adapter';
import { MediumLockService } from '../storage/medium-locks';
import { STORAGE_ADAPTER } from '../storage/storage-adapter.port';

/**
 * Operational engine plus its storage layer. Everything lives in one
 * injector on purpose: the worker needs the engine, the engine needs
 * the lock port, and the scheduler dispatches to the worker — injecting
 * the handler into the scheduler would close a resolution cycle that
 * hangs Nest silently, so the worker self-registers in onModuleInit
 * instead. Code is organized by layer (`engine/` = operational KV,
 * `storage/` = medium), wired here as one bounded context.
 */
@Module({
  providers: [
    StorageEngineService,
    FlushScheduler,
    DictionaryCache,
    BlockManager,
    MediumLockService,
    LocalFilesystemAdapter,
    FlushWorker,
    { provide: STORAGE_ADAPTER, useClass: LocalFilesystemAdapter },
    { provide: BLOCK_LOCKS, useExisting: MediumLockService },
    { provide: FLUSH_HANDLER, useExisting: FlushWorker },
  ],
  exports: [StorageEngineService, FlushScheduler, FlushWorker],
})
export class EngineModule {}
