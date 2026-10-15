import { getJobHandler, registerJobHandler } from './job.registry';

describe('job.registry', () => {
  it('returns a registered handler', () => {
    registerJobHandler('spec.ping', jest.fn());
    expect(typeof getJobHandler('spec.ping')).toBe('function');
  });

  it('throws for an unregistered key', () => {
    expect(() => getJobHandler('spec.missing')).toThrow(
      /No handler registered for job key: "spec.missing"/,
    );
  });

  it('overwrites an existing handler under the same key', () => {
    const first = jest.fn();
    const second = jest.fn();
    registerJobHandler('spec.overwrite', first);
    registerJobHandler('spec.overwrite', second);
    expect(getJobHandler('spec.overwrite')).toBe(second);
  });
});
