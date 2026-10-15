import { registerJobHandler } from './job.registry';
import { MemoryJobsProvider } from './memory.jobs-provider';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('MemoryJobsProvider', () => {
  let provider: MemoryJobsProvider;
  const handler = jest.fn();

  beforeAll(() => {
    registerJobHandler('spec.memory', handler);
  });

  beforeEach(() => {
    provider = new MemoryJobsProvider();
    handler.mockReset();
  });

  afterEach(async () => {
    await provider.close();
  });

  it('executes a scheduled job through the handler registry', async () => {
    const scheduled = await provider.triggerJob({
      handler: 'spec.memory',
      payload: { hello: 'world' },
    });
    expect(scheduled.status).toBe('PENDING');

    await settle();
    expect(handler).toHaveBeenCalledWith({ hello: 'world' });

    const jobs = await provider.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: scheduled.id, status: 'COMPLETED' });
  });

  it('lists jobs filtered by status', async () => {
    await provider.triggerJob({ handler: 'spec.memory', payload: {} });
    await settle();

    const completed = await provider.listJobs('COMPLETED');
    const pending = await provider.listJobs('PENDING');
    expect(completed).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });

  it('marks a failed job as FAILED', async () => {
    registerJobHandler(
      'spec.failing',
      jest.fn().mockRejectedValue(new Error('boom')),
    );
    await provider.triggerJob({
      handler: 'spec.failing',
      payload: {},
      maxAttempts: 1,
    });
    await settle();

    const jobs = await provider.listJobs('FAILED');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].error).toBe('boom');
  });

  it('schedules chunked jobs grouped by chunk size', async () => {
    const result = await provider.triggerChunked({
      handler: 'spec.memory',
      items: [1, 2, 3, 4, 5],
      chunkSize: 2,
    });
    expect(result.scheduled).toBe(3);
    await settle();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenCalledWith({
      chunk: [1, 2],
      chunkIndex: 0,
      totalChunks: 3,
    });
  });
});
