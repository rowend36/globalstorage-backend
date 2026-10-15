import { DynamicModule, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { isProduction } from '../config/configuration';
import { BullmqJobsProvider, JOBS_QUEUE } from './bullmq.jobs-provider';
import { JobWorker } from './job.worker';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JOBS_PROVIDER } from './jobs.port';
import { MemoryJobsProvider } from './memory.jobs-provider';

const redisUrl = (): string =>
  process.env.QUEUE_REDIS_URL || process.env.REDIS_URL || '';

@Module({})
export class JobsModule {
  static register(): DynamicModule {
    const url = redisUrl();
    if (isProduction() && !url) {
      throw new Error(
        'QUEUE_REDIS_URL is required for the jobs module in production',
      );
    }

    if (url) {
      return {
        module: JobsModule,
        controllers: [JobsController],
        imports: [
          BullModule.forRoot({
            connection: { url },
            defaultJobOptions: {
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: 1000,
              removeOnFail: 5000,
            },
          }),
          BullModule.registerQueue({ name: JOBS_QUEUE }),
        ],
        providers: [
          BullmqJobsProvider,
          JobWorker,
          { provide: JOBS_PROVIDER, useExisting: BullmqJobsProvider },
          JobsService,
        ],
        exports: [JOBS_PROVIDER, JobsService],
      };
    }

    return {
      module: JobsModule,
      controllers: [JobsController],
      providers: [
        MemoryJobsProvider,
        { provide: JOBS_PROVIDER, useExisting: MemoryJobsProvider },
        JobsService,
      ],
      exports: [JOBS_PROVIDER, JobsService],
    };
  }
}
