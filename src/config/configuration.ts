export type Driver = 'sqlite' | 'postgresql';
export type Provider =
  'filesystem' | 's3' | 'smtp' | 'resend' | 'console' | 'redis' | 'memory';

const number = (name: string, value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!value.trim() || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric configuration value for ${name}`);
  }
  return parsed;
};

const boolean = (name: string, value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Invalid boolean configuration value for ${name}`);
  }
  return value === 'true';
};

const choice = <T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T => {
  const selected = value ?? fallback;
  if (!allowed.includes(selected as T)) {
    throw new Error(
      `Invalid configuration value for ${name}; expected one of ${allowed.join(', ')}`,
    );
  }
  return selected as T;
};

const formatFrom = (
  fallback: string,
  address: string | undefined,
  name: string | undefined,
): string => {
  const resolvedAddress = address ?? fallback;
  const resolvedName = name?.trim();
  return resolvedName ? `${resolvedName} <${resolvedAddress}>` : resolvedAddress;
};

export const isProduction = (): boolean => {
  return process.env.NODE_ENV === 'production';
};

const requireInProduction = (
  name: string,
  value: string | undefined,
): string => {
  if (isProduction() && (!value || value === 'change-me-before-deploying')) {
    throw new Error(
      `Missing required environment variable "${name}" in production`,
    );
  }
  return value ?? '';
};

const parseLabels = (): Record<string, string> => {
  const raw = process.env.LOKI_LABELS;
  if (raw === undefined || raw.trim() === '') {
    return { application: 'globalstorage-backend' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON configuration value for LOKI_LABELS');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.entries(parsed).some(([, value]) => typeof value !== 'string')
  ) {
    throw new Error('Invalid configuration value for LOKI_LABELS');
  }
  return parsed as Record<string, string>;
};

const allowSuperuserClaim = (): boolean => {
  const enabled = process.env.ALLOW_SUPERUSER_CLAIM === 'true';
  if (enabled && isProduction())
    throw new Error('ALLOW_SUPERUSER_CLAIM cannot be enabled in production');
  return enabled;
};

/**
 * Deployment variables select capabilities.  Application code must only read
 * this object; it must never branch on NODE_ENV.
 */
export const configuration = () => {
  const jwtSecret = requireInProduction('JWT_SECRET', process.env.JWT_SECRET);
  const refreshHashPepper = requireInProduction(
    'REFRESH_HASH_PEPPER',
    process.env.REFRESH_HASH_PEPPER,
  );
  const dbPassword = requireInProduction(
    'DB_PASSWORD',
    process.env.DB_PASSWORD,
  );

  return {
    app: {
      port: number('PORT', process.env.PORT, 3000),
      apiVersion: process.env.API_VERSION ?? '1',
      corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
      swaggerEnabled: boolean('SWAGGER_ENABLED', process.env.SWAGGER_ENABLED, false),
    },
    auth: {
      jwtSecret: jwtSecret || 'change-me-before-deploying',
      jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
      cookieName: process.env.AUTH_COOKIE_NAME ?? 'access_token',
      refreshCookieName: process.env.REFRESH_COOKIE_NAME ?? 'refresh_token',
      refreshHashPepper: refreshHashPepper || 'change-me-before-deploying',
      refreshIdleTtlSeconds: number(
        'REFRESH_IDLE_TTL_SECONDS',
        process.env.REFRESH_IDLE_TTL_SECONDS,
        60 * 60 * 24 * 30,
      ),
      sessionAbsoluteTtlSeconds: number(
        'SESSION_ABSOLUTE_TTL_SECONDS',
        process.env.SESSION_ABSOLUTE_TTL_SECONDS,
        60 * 60 * 24 * 90,
      ),
      csrfCookieName: process.env.CSRF_COOKIE_NAME ?? 'csrf_token',
      cookieSecure: boolean('AUTH_COOKIE_SECURE', process.env.AUTH_COOKIE_SECURE, true),
      platformMfaPolicy: choice(
        'PLATFORM_MFA_POLICY',
        process.env.PLATFORM_MFA_POLICY,
        ['any', 'totp', 'email'],
        'any',
      ),
    },
    database: {
      driver: choice<Driver>(
        'DATABASE_DRIVER',
        process.env.DATABASE_DRIVER,
        ['sqlite', 'postgresql'],
        'sqlite',
      ),
      sqlite: { path: process.env.SQLITE_PATH ?? 'data/app.sqlite' },
      postgres: {
        host: process.env.DB_HOST,
        port: number('DB_PORT', process.env.DB_PORT, 5432),
        user: process.env.DB_USER ?? 'postgres',
        password: dbPassword || 'postgres',
        database: process.env.DB_NAME ?? 'globalstorage',
      },
    },
    cache: {
      provider: choice('CACHE_PROVIDER', process.env.CACHE_PROVIDER, ['memory', 'redis'], 'memory'),
      redisUrl: process.env.REDIS_URL,
    },
    queue: {
      provider: choice('QUEUE_PROVIDER', process.env.QUEUE_PROVIDER, ['memory', 'redis'], 'memory'),
      redisUrl: process.env.QUEUE_REDIS_URL ?? process.env.REDIS_URL,
      workerConcurrency: number(
        'QUEUE_WORKER_CONCURRENCY',
        process.env.QUEUE_WORKER_CONCURRENCY,
        5,
      ),
    },
    storage: {
      provider: choice(
        'STORAGE_PROVIDER',
        process.env.STORAGE_PROVIDER,
        ['filesystem', 's3'],
        'filesystem',
      ),
      directory: process.env.STORAGE_DIRECTORY ?? 'uploads',
      publicUrl: process.env.STORAGE_PUBLIC_URL,
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
    },
    spaces: {
      defaultQuotaBytes: number(
        'SPACE_DEFAULT_QUOTA_BYTES',
        process.env.SPACE_DEFAULT_QUOTA_BYTES,
        50 * 1024 * 1024,
      ),
      aggregateQuotaBytes: number(
        'USER_AGGREGATE_QUOTA_BYTES',
        process.env.USER_AGGREGATE_QUOTA_BYTES,
        1024 * 1024 * 1024,
      ),
      maxKeyBytes: number('MAX_KEY_BYTES', process.env.MAX_KEY_BYTES, 10 * 1024 * 1024),
    },
    persistence: {
      provider: choice(
        'PERSISTENCE_PROVIDER',
        process.env.PERSISTENCE_PROVIDER,
        ['local'],
        'local',
      ),
      directory: process.env.PERSISTENCE_DIRECTORY ?? 'data/provider',
    },
    mail: {
      provider: choice(
        'MAIL_PROVIDER',
        process.env.MAIL_PROVIDER,
        ['console', 'smtp', 'resend'],
        'console',
      ),
      from: formatFrom(
        'noreply@example.test',
        process.env.MAIL_FROM,
        process.env.MAIL_FROM_NAME,
      ),
      frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
      smtpUrl: process.env.SMTP_URL,
      resendApiKey: process.env.RESEND_API_KEY,
    },
    sms: {
      provider: choice('SMS_PROVIDER', process.env.SMS_PROVIDER, ['console'], 'console'),
    },
    oidc: {
      issuerUrl: process.env.OIDC_ISSUER_URL,
      clientId: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      redirectUri: process.env.OIDC_REDIRECT_URI,
      scopes: process.env.OIDC_SCOPES ?? 'openid profile email',
    },
    monitoring: {
      provider: choice(
        'MONITORING_PROVIDER',
        process.env.MONITORING_PROVIDER,
        ['console', 'sentry'],
        'console',
      ),
      dsn: process.env.SENTRY_DSN,
    },
    logging: {
      level: process.env.LOG_LEVEL ?? 'info',
      filePath: process.env.LOG_FILE ?? '',
      pretty: boolean('LOG_PRETTY', process.env.LOG_PRETTY, false),
      loki: {
        url: process.env.LOKI_URL ?? '',
        username: process.env.LOKI_USERNAME,
        password: process.env.LOKI_PASSWORD,
        orgId: process.env.LOKI_ORG_ID,
        labels: parseLabels(),
      },
    },
    telemetry: {
      enabled: boolean('OTEL_ENABLED', process.env.OTEL_ENABLED, false),
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'globalstorage-backend',
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    security: {
      fieldEncryptionKey: process.env.FIELD_ENCRYPTION_KEY,
      fieldEncryptionKeys: process.env.FIELD_ENCRYPTION_KEYS,
      fieldEncryptionCurrentVersion:
        process.env.FIELD_ENCRYPTION_CURRENT_VERSION,
    },
    authorization: { allowSuperuserClaim: allowSuperuserClaim() },
  };
};

export type AppConfig = ReturnType<typeof configuration>;
