import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type {
  JobsPort,
  TriggerBatchInput,
  TriggerChunkedInput,
  TriggerJobInput,
} from './jobs.port';
import { bullJobStatus, chunkArray, delayFrom } from './job-utils';

export const JOBS_QUEUE = 'globalstorage-jobs';

const JOB_STATES = [
  'waiting',
  'active',
  'completed',
  'failed',
  'delayed',
] as const;

@Injectable()
export class BullmqJobsProvider implements JobsPort {
  private readonly logger = new Logger(BullmqJobsProvider.name);

  constructor(@InjectQueue(JOBS_QUEUE) private readonly queue: Queue) {}

  async triggerJob(input: TriggerJobInput) {
    const job = await this.queue.add(
      input.handler,
      { handler: input.handler, payload: input.payload },
      {
        delay: delayFrom(input.runAt),
        attempts: input.maxAttempts ?? 3,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    this.logger.log(`Scheduled job ${job.id} (${input.handler})`);
    return {
      id: String(job.id),
      handler: input.handler,
      status: 'PENDING' as const,
    };
  }

  async triggerBatch(input: TriggerBatchInput) {
    const delay = delayFrom(input.runAt);
    const attempts = input.maxAttempts ?? 3;
    const jobs = await this.queue.addBulk(
      input.payloads.map((payload) => ({
        name: input.handler,
        data: { handler: input.handler, payload },
        opts: { delay, attempts, removeOnComplete: 1000, removeOnFail: 5000 },
      })),
    );
    this.logger.log(`Scheduled ${jobs.length} jobs (${input.handler})`);
    return {
      scheduled: jobs.length,
      jobs: jobs.map((job) => ({
        id: String(job.id),
        handler: input.handler,
        status: 'PENDING' as const,
      })),
    };
  }

  async triggerChunked(input: TriggerChunkedInput) {
    const delay = delayFrom(input.runAt);
    const attempts = input.maxAttempts ?? 3;
    const chunks = chunkArray(input.items, input.chunkSize);
    const jobs = await this.queue.addBulk(
      chunks.map((chunk, index) => ({
        name: input.handler,
        data: {
          handler: input.handler,
          payload: { chunk, chunkIndex: index, totalChunks: chunks.length },
        },
        opts: { delay, attempts, removeOnComplete: 1000, removeOnFail: 5000 },
      })),
    );
    this.logger.log(`Scheduled ${jobs.length} jobs (${input.handler})`);
    return {
      scheduled: jobs.length,
      chunkSize: input.chunkSize,
      jobs: jobs.map((job) => ({
        id: String(job.id),
        handler: input.handler,
        status: 'PENDING' as const,
      })),
    };
  }

  async listJobs(status?: string) {
    const all = await this.queue.getJobs([...JOB_STATES]);
    const mapped = all.map((job) => ({
      id: String(job.id),
      name: job.name,
      handler: job.name,
      payload:
        (job.data as { payload?: Record<string, unknown> }).payload ?? {},
      status: bullJobStatus(job),
      attempts: job.attemptsMade,
      maxAttempts: job.opts?.attempts ?? 3,
      createdAt: job.timestamp ? new Date(job.timestamp) : undefined,
      error: job.failedReason ?? undefined,
    }));
    return status ? mapped.filter((job) => job.status === status) : mapped;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
