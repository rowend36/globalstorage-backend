import type { JobStatus } from './jobs.port';

export function delayFrom(runAt?: Date): number {
  return runAt ? Math.max(0, runAt.getTime() - Date.now()) : 0;
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}

export function bullJobStatus(job: {
  failedReason?: string | null;
  finishedOn?: number | null;
  processedOn?: number | null;
}): JobStatus {
  if (job.failedReason) return 'FAILED';
  if (job.finishedOn) return 'COMPLETED';
  if (job.processedOn) return 'RUNNING';
  return 'PENDING';
}
