import { DatabaseHealthIndicator } from './database-health.indicator';

describe('DatabaseHealthIndicator', () => {
  const indicator = {
    check: jest.fn((key: string) => ({
      up: jest.fn((details?: unknown) => ({ [key]: { status: 'up', ...(details as object) } })),
      down: jest.fn((details?: unknown) => ({
        [key]: {
          status: 'down',
          ...(typeof details === 'string' ? { message: details } : (details as object)),
        },
      })),
    })),
  };

  const execute = jest.fn();
  const orm = {
    em: { getConnection: jest.fn(() => ({ execute })) },
    driver: { constructor: { name: 'PostgreSqlDriver' } },
  };

  beforeEach(() => jest.clearAllMocks());

  it('reports the database as up when a round-trip succeeds', async () => {
    execute.mockResolvedValueOnce([{ ok: 1 }]);
    const service = new DatabaseHealthIndicator(indicator as never, orm as never);
    await expect(service.ping('database')).resolves.toEqual({
      database: { status: 'up', driver: 'PostgreSqlDriver' },
    });
  });

  it('reports the database as down when the query fails', async () => {
    execute.mockRejectedValueOnce(new Error('connection refused'));
    const service = new DatabaseHealthIndicator(indicator as never, orm as never);
    await expect(service.ping('database')).resolves.toEqual({
      database: { status: 'down', message: 'connection refused' },
    });
  });

  it('reports a timeout when the query does not return in time', async () => {
    execute.mockImplementationOnce(() => new Promise(() => {}));
    const service = new DatabaseHealthIndicator(indicator as never, orm as never);
    await expect(service.ping('database', 10)).resolves.toEqual({
      database: { status: 'down', message: 'timeout of 10ms exceeded' },
    });
  });
});