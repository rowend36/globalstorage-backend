import { Inject, Injectable } from '@nestjs/common';
import type {
  TriggerBatchInput,
  TriggerChunkedInput,
  TriggerJobInput,
} from './jobs.dto';
import { JOBS_PROVIDER, type JobsPort } from './jobs.port';

const toDate = (runAt?: string): Date | undefined =>
  runAt ? new Date(runAt) : undefined;

@Injectable()
export class JobsService {
  constructor(@Inject(JOBS_PROVIDER) private readonly jobs: JobsPort) {}

  async triggerJob(input: TriggerJobInput) {
    return this.jobs.triggerJob({
      handler: input.handler,
      name: input.name,
      payload: input.payload ?? {},
      runAt: toDate(input.runAt),
      maxAttempts: input.maxAttempts,
    });
  }

  async triggerBatch(input: TriggerBatchInput) {
    return this.jobs.triggerBatch({
      handler: input.handler,
      payloads: input.payloads,
      runAt: toDate(input.runAt),
      maxAttempts: input.maxAttempts,
    });
  }

  async triggerChunked(input: TriggerChunkedInput) {
    return this.jobs.triggerChunked({
      handler: input.handler,
      items: input.items,
      chunkSize: input.chunkSize ?? 50,
      runAt: toDate(input.runAt),
      maxAttempts: input.maxAttempts,
    });
  }

  async listJobs(status?: string) {
    return this.jobs.listJobs(status);
  }
}
