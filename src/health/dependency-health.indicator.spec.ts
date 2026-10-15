import { DependencyHealthIndicator } from './dependency-health.indicator';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

import nodemailer from 'nodemailer';

describe('DependencyHealthIndicator', () => {
  const config = { get: jest.fn() };
  const indicator = {
    check: jest.fn((key: string) => ({
      up: jest.fn((details?: unknown) => ({ [key]: { status: 'up', ...(details as object) } })),
      down: jest.fn((details?: unknown) => ({
        [key]: {
          status: 'down',
          ...(typeof details === 'string' ? { message: details } : details as object),
        },
      })),
    })),
  };

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.useRealTimers());

  it('reports memory-backed Redis and console mail as healthy', async () => {
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    expect(await service.redis('cache', 'memory')).toEqual({ cache: { status: 'up', provider: 'memory' } });
    config.get.mockImplementation((key: string) => (key === 'storage.provider' ? 'filesystem' : key === 'storage.directory' ? 'uploads' : 'console'));
    expect(await service.mail()).toEqual({ mail: { status: 'up', provider: 'console' } });
  });

  it('reports missing Redis and mail configuration as unhealthy', async () => {
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    expect(await service.redis('cache', 'redis')).toEqual({ cache: { status: 'down', message: 'Redis URL is not configured' } });
    config.get.mockImplementation((key: string) =>
      key === 'mail.provider' ? 'smtp' : key === 'mail' ? { smtpUrl: undefined } : undefined,
    );
    expect(await service.mail()).toEqual({ mail: { status: 'down', provider: 'smtp', message: 'Required configuration is missing for smtp' } });
  });

  it('reports SMTP mail as healthy when the transport handshake succeeds', async () => {
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    const transport = { verify: jest.fn().mockResolvedValue(true), close: jest.fn() };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);
    config.get.mockImplementation((key: string) =>
      key === 'mail.provider' ? 'smtp' : key === 'mail' ? { smtpUrl: 'smtp://user:pass@mail.example.com:587' } : undefined,
    );
    expect(await service.mail()).toEqual({ mail: { status: 'up', provider: 'smtp' } });
    expect(transport.close).toHaveBeenCalled();
  });

  it('reports SMTP mail as unhealthy when the transport handshake fails', async () => {
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    const transport = {
      verify: jest.fn().mockRejectedValue(new Error('Invalid login')),
      close: jest.fn(),
    };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);
    config.get.mockImplementation((key: string) =>
      key === 'mail.provider' ? 'smtp' : key === 'mail' ? { smtpUrl: 'smtp://user:pass@mail.example.com:587' } : undefined,
    );
    expect(await service.mail()).toEqual({ mail: { status: 'down', provider: 'smtp', message: 'Invalid login' } });
    expect(transport.close).toHaveBeenCalled();
  });

  it('reports SMTP mail as unhealthy when the transport handshake times out', async () => {
    jest.useFakeTimers();
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    const transport = {
      verify: jest.fn(
        () =>
          new Promise((_finish, _fail) => {
            /* never settles */
          }),
      ),
      close: jest.fn(),
    };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(transport);
    config.get.mockImplementation((key: string) =>
      key === 'mail.provider' ? 'smtp' : key === 'mail' ? { smtpUrl: 'smtp://user:pass@mail.example.com:587' } : undefined,
    );
const mailPromise = service.mail();
    jest.advanceTimersByTime(5001);
    await expect(mailPromise).resolves.toEqual({
      mail: {
        status: 'down',
        provider: 'smtp',
        message: 'Health check timed out after 5000ms',
      },
    });
  });

  it('reports missing Resend configuration as unhealthy', async () => {
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    config.get.mockImplementation((key: string) =>
      key === 'mail.provider' ? 'resend' : key === 'mail' ? { resendApiKey: undefined } : undefined,
    );
    expect(await service.mail()).toEqual({ mail: { status: 'down', provider: 'resend', message: 'Required configuration is missing for resend' } });
  });

  it('reports Resend mail as healthy when the API key is accepted', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    config.get.mockImplementation((key: string) =>
      key === 'mail.provider' ? 'resend' : key === 'mail' ? { resendApiKey: 're_secret' } : undefined,
    );
    const result = await service.mail();
    expect(result).toEqual({ mail: { status: 'up', provider: 'resend' } });
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/domains', {
      headers: { Authorization: 'Bearer re_secret' },
    });
    fetchMock.mockRestore();
  });

  it('reports Resend mail as unhealthy when the API key is rejected', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401 } as Response);
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    config.get.mockImplementation((key: string) =>
      key === 'mail.provider' ? 'resend' : key === 'mail' ? { resendApiKey: 're_secret' } : undefined,
    );
    expect(await service.mail()).toEqual({ mail: { status: 'down', provider: 'resend', message: 'Resend API returned 401' } });
    fetchMock.mockRestore();
  });

  it('reports Resend mail as unhealthy when the API probe times out', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      () =>
        new Promise((_finish, _fail) => {
          /* never settles */
        }),
    );
    const service = new DependencyHealthIndicator(config as never, indicator as never);
    config.get.mockImplementation((key: string) =>
      key === 'mail.provider' ? 'resend' : key === 'mail' ? { resendApiKey: 're_secret' } : undefined,
    );
    const mailPromise = service.mail();
    jest.advanceTimersByTime(5001);
    await expect(mailPromise).resolves.toEqual({
      mail: {
        status: 'down',
        provider: 'resend',
        message: 'Health check timed out after 5000ms',
      },
    });
    fetchMock.mockRestore();
  });
});