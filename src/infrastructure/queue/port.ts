export const QUEUE_PROVIDER = Symbol('QUEUE_PROVIDER');

export interface QueuePort {
  add(name: string, payload: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}
