import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { getJobHandler } from './job.registry';
import { JOBS_QUEUE } from './bullmq.jobs-provider';
import { TelemetryService } from '../telemetry.service';

@Injectable()
@Processor(JOBS_QUEUE, {
  concurrency: Number(process.env.QUEUE_WORKER_CONCURRENCY ?? 5),
})
export class JobWorker extends WorkerHost {
  private readonly logger = new Logger(JobWorker.name);

  constructor(private readonly telemetry: TelemetryService) {
    super();
  }

  async process(job: Job): Promise<void> {
    await this.telemetry.run(
      'job.process',
      async () => {
        const handler = getJobHandler(job.name);
        const payload = (job.data as { payload?: Record<string, unknown> })
          .payload;
        await handler(payload ?? {});
        this.logger.log(`Completed job ${job.id} (${job.name})`);
      },
      { 'job.id': String(job.id), 'job.name': job.name },
    );
  }
}
