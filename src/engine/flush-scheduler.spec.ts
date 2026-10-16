import { FlushScheduler } from './flush-scheduler';

const configFor = (debounceMs: number) =>
  ({
    get: () => ({ flushDebounceMs: debounceMs, syncCooldownMs: 5000 }),
  }) as never;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FlushScheduler', () => {
  it('debounces rapid schedules into one handler call', async () => {
    const calls: string[][] = [];
    const scheduler = new FlushScheduler(configFor(10));
    scheduler.registerHandler({
      handle: async (spaceIds: string[]) => {
        calls.push(spaceIds);
        return [];
      },
    });
    scheduler.schedule('a');
    scheduler.schedule('b');
    scheduler.schedule('a');
    await sleep(50);
    expect(calls).toHaveLength(1);
    expect(new Set(calls[0])).toEqual(new Set(['a', 'b']));
    expect(scheduler.pendingSpaces()).toEqual([]);
    scheduler.onModuleDestroy();
  });

  it('drains on demand and retains batches when the handler fails', async () => {
    let failures = 1;
    const calls: string[][] = [];
    const scheduler = new FlushScheduler(configFor(10_000));
    scheduler.registerHandler({
      handle: async (spaceIds: string[]) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('worker down');
        }
        calls.push(spaceIds);
        return [];
      },
    });
    scheduler.schedule('a');
    await scheduler.drain();
    expect(calls).toHaveLength(0);
    expect(scheduler.pendingSpaces()).toEqual(['a']);
    await scheduler.drain();
    expect(calls).toEqual([['a']]);
    scheduler.onModuleDestroy();
  });

  it('retains batches when no handler is registered', async () => {
    const scheduler = new FlushScheduler(configFor(10));
    scheduler.schedule('a');
    await scheduler.drain();
    expect(scheduler.pendingSpaces()).toEqual(['a']);
    scheduler.cancel('a');
    expect(scheduler.pendingSpaces()).toEqual([]);
    scheduler.onModuleDestroy();
  });

  it('retains spaces the handler reports back and retries them', async () => {
    const scheduler = new FlushScheduler(configFor(10_000));
    scheduler.registerHandler({ handle: async () => ['a'] });
    scheduler.schedule('a');
    scheduler.schedule('b');
    await scheduler.drain();
    expect(scheduler.pendingSpaces()).toEqual(['a']);
    scheduler.onModuleDestroy();
  });
});
