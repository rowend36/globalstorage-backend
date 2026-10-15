import { Injectable, Logger } from '@nestjs/common';
import { getJobHandler } from './job.registry';
import type {
  JobsPort,
  JobStatus,
  TriggerBatchInput,
  TriggerChunkedInput,
  TriggerJobInput,
} from './jobs.port';
import { chunkArray, delayFrom } from './job-utils';

interface MemoryJob {
  id: string;
  handler: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  maxAttempts: number;
  createdAt: Date;
  error?: string;
}

/**
 * Development-only queue provider. Executes jobs in-process on a timer so the
 * application can run without Redis. Uses the job handler registry directly.
 */
@Injectable()
export class MemoryJobsProvider implements JobsPort {
  private readonly logger = new Logger(MemoryJobsProvider.name);
  private readonly jobs: MemoryJob[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private counter = 0;

  // eslint-disable-next-line @typescript-eslint/require-await
  async triggerJob(input: TriggerJobInput) {
    const job: MemoryJob = {
      id: `mem-${++this.counter}`,
      handler: input.handler,
      payload: input.payload,
      status: 'PENDING',
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: new Date(),
    };
    this.jobs.push(job);
    this.schedule(job, delayFrom(input.runAt));
    return { id: job.id, handler: job.handler, status: job.status };
  }

  async triggerBatch(input: TriggerBatchInput) {
    const done = await Promise.all(
      input.payloads.map((payload) =>
        this.triggerJob({
          handler: input.handler,
          payload,
          runAt: input.runAt,
          maxAttempts: input.maxAttempts,
        }),
      ),
    );
    return { scheduled: done.length, jobs: done };
  }

  async triggerChunked(input: TriggerChunkedInput) {
    const chunks = chunkArray(input.items, input.chunkSize);
    const jobs = [];
    for (let index = 0; index < chunks.length; index += 1) {
      jobs.push(
        await this.triggerJob({
          handler: input.handler,
          payload: {
            chunk: chunks[index],
            chunkIndex: index,
            totalChunks: chunks.length,
          },
          runAt: input.runAt,
          maxAttempts: input.maxAttempts,
        }),
      );
    }
    return { scheduled: jobs.length, chunkSize: input.chunkSize, jobs };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listJobs(status?: string) {
    const mapped = this.jobs.map((job) => ({
      id: job.id,
      name: job.handler,
      handler: job.handler,
      payload: job.payload,
      status: job.status,
      attempts: 0,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      error: job.error,
    }));
    return status ? mapped.filter((job) => job.status === status) : mapped;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }

  private schedule(job: MemoryJob, delayMs: number): void {
    const timer = setTimeout(() => void this.run(job), delayMs);
    this.timers.push(timer);
  }

  private async run(job: MemoryJob): Promise<void> {
    const current = this.jobs.find((candidate) => candidate.id === job.id);
    if (!current || current.status !== 'PENDING') return;
    current.status = 'RUNNING';
    for (let attempt = 1; attempt <= current.maxAttempts; attempt += 1) {
      try {
        const handler = getJobHandler(current.handler);
        await handler(current.payload);
        current.status = 'COMPLETED';
        this.logger.log(`Job ${current.id} (${current.handler}) completed`);
        return;
      } catch (err) {
        current.error = err instanceof Error ? err.message : String(err);
        if (attempt < current.maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
        }
      }
    }
    current.status = 'FAILED';
    this.logger.error(
      `Job ${current.id} (${current.handler}) failed: ${current.error}`,
    );
  }
}
