export const JOBS_PROVIDER = Symbol('JOBS_PROVIDER');

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface TriggerJobInput {
  handler: string;
  name?: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}

export interface TriggerBatchInput {
  handler: string;
  payloads: Array<Record<string, unknown>>;
  runAt?: Date;
  maxAttempts?: number;
}

export interface TriggerChunkedInput {
  handler: string;
  items: unknown[];
  chunkSize: number;
  runAt?: Date;
  maxAttempts?: number;
}

export interface ScheduledJob {
  id: string | number;
  handler: string;
  status: JobStatus;
}

export interface JobsPort {
  triggerJob(input: TriggerJobInput): Promise<ScheduledJob>;
  triggerBatch(input: TriggerBatchInput): Promise<{
    scheduled: number;
    jobs: ScheduledJob[];
  }>;
  triggerChunked(input: TriggerChunkedInput): Promise<{
    scheduled: number;
    chunkSize: number;
    jobs: ScheduledJob[];
  }>;
  listJobs(status?: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}
