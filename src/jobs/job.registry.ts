/**
 * Job handler registry.
 *
 * Maps handler keys (strings) to the functions that execute the job. Register
 * all background job handlers here.
 *
 * Handler contract:
 *   - Receives a `payload` object (JSON from the queue)
 *   - Returns `Promise<void>`
 *   - Throws on unrecoverable errors (BullMQ marks the job FAILED and retries)
 *
 * Adding a new handler:
 *   1. Write your handler function (or import from a service)
 *   2. Add it to the registry via `registerJobHandler`
 *   3. Schedule it via POST /v1/jobs/trigger
 */
import { Logger } from '@nestjs/common';

const logger = new Logger('JobRegistry');

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/** The global registry: handler key → handler function */
const registry = new Map<string, JobHandler>();

export function registerJobHandler(key: string, handler: JobHandler): void {
  if (registry.has(key))
    logger.warn(`Overwriting existing job handler: ${key}`);
  registry.set(key, handler);
  logger.log(`Job handler registered: ${key}`);
}

export function getJobHandler(key: string): JobHandler {
  const handler = registry.get(key);
  if (!handler) throw new Error(`No handler registered for job key: "${key}"`);
  return handler;
}

registerJobHandler('example.ping', () => {
  logger.log('PING job executed successfully');
  return Promise.resolve();
});

registerJobHandler('example.log', (payload) => {
  logger.log(`LOG job executed: ${JSON.stringify(payload)}`);
  return Promise.resolve();
});
