import { configuration } from './configuration';

describe('configuration', () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
  });

  it('returns validated defaults', () => {
    const config = configuration();
    expect(config.app.port).toBe(3000);
    expect(config.database.driver).toBe('sqlite');
    expect(config.cache.provider).toBe('memory');
    expect(config.queue.provider).toBe('memory');
    expect(config.storage.provider).toBe('filesystem');
    expect(config.mail.provider).toBe('console');
    expect(config.app.swaggerEnabled).toBe(false);
    expect(config.logging.pretty).toBe(false);
    expect(config.logging.loki).toEqual({
      url: '',
      username: undefined,
      password: undefined,
      orgId: undefined,
      labels: { application: 'globalstorage-backend' },
    });
  });

  it('reads LOG_PRETTY and LOKI_* overrides', () => {
    process.env.LOG_PRETTY = 'true';
    process.env.LOKI_URL = 'https://logs-prod.example.grafana.net';
    process.env.LOKI_USERNAME = 'instance-123';
    process.env.LOKI_PASSWORD = 'secret';
    process.env.LOKI_ORG_ID = 'instance-123';
    process.env.LOKI_LABELS = '{"application":"globalstorage-backend","env":"preview"}';

    const config = configuration();
    expect(config.logging.pretty).toBe(true);
    expect(config.logging.loki).toEqual({
      url: 'https://logs-prod.example.grafana.net',
      username: 'instance-123',
      password: 'secret',
      orgId: 'instance-123',
      labels: { application: 'globalstorage-backend', env: 'preview' },
    });
  });

  it('rejects malformed LOKI_LABELS', () => {
    process.env.LOKI_LABELS = '{not-json';
    expect(() => configuration()).toThrow('Invalid JSON configuration value for LOKI_LABELS');
  });

  it('rejects non-flat LOKI_LABELS', () => {
    process.env.LOKI_LABELS = '{"application": 42}';
    expect(() => configuration()).toThrow('Invalid configuration value for LOKI_LABELS');
  });

  it.each([
    ['PORT', 'not-a-number'],
    ['DB_PORT', '-1'],
    ['QUEUE_WORKER_CONCURRENCY', '1.5'],
  ])('rejects invalid numeric value in %s', (name, value) => {
    process.env[name] = value;
    expect(() => configuration()).toThrow(`Invalid numeric configuration value for ${name}`);
  });

  it.each(['AUTH_COOKIE_SECURE', 'OTEL_ENABLED', 'SWAGGER_ENABLED', 'LOG_PRETTY'])('rejects invalid boolean value in %s', (name) => {
    process.env[name] = 'yes';
    expect(() => configuration()).toThrow(`Invalid boolean configuration value for ${name}`);
  });

  it.each([
    ['DATABASE_DRIVER', 'mysql'],
    ['CACHE_PROVIDER', 'redis-cache'],
    ['QUEUE_PROVIDER', 'bullmq'],
    ['STORAGE_PROVIDER', 'minio'],
    ['MAIL_PROVIDER', 'sendgrid'],
    ['SMS_PROVIDER', 'twilio'],
    ['MONITORING_PROVIDER', 'datadog'],
  ])('rejects unsupported value in %s', (name, value) => {
    process.env[name] = value;
    expect(() => configuration()).toThrow(`Invalid configuration value for ${name}`);
  });
});
