import { Injectable } from '@nestjs/common';
import type { QueuePort } from '../queue.port';

@Injectable()
export class MemoryQueueProvider implements QueuePort {
  // eslint-disable-next-line @typescript-eslint/require-await
  async add(name: string, payload: Record<string, unknown>): Promise<void> {
    console.info({ name, payload }, 'inline queue job');
  }

  async close(): Promise<void> {}
}
