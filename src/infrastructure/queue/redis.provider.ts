import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AppConfig } from '../../config/configuration';
import type { QueuePort } from '../queue.port';

@Injectable()
export class BullMqQueueProvider implements QueuePort {
  private queue?: Queue;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async add(name: string, payload: Record<string, unknown>): Promise<void> {
    const url = this.config.get('queue.redisUrl', { infer: true });
    if (!url) throw new Error('QUEUE_REDIS_URL is required for BullMQ');
    this.queue ??= new Queue('default', { connection: { url } });
    await this.queue.add(name, payload, {
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async close(): Promise<void> {
    await this.queue?.close();
  }
}
