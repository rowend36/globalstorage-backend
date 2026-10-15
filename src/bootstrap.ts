import {
  ForbiddenException,
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppConfig } from './config/configuration';
import { requestContext } from './infrastructure/request-context';
import { HttpAdapterHost } from '@nestjs/core';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';

const CSRF_EXCLUDED_PREFIXES = [
  '/v1/auth/login',
  '/v1/auth/oidc',
  '/v1/auth/forgot-password',
  '/v1/auth/reset-password',
];

export function configureApplication(app: INestApplication): void {
  const config = app.get(ConfigService<AppConfig, true>);

  const corsOrigins = config.get('app.corsOrigins', { infer: true });
  if (corsOrigins.length) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  }

  app.use(helmet());
  app.use(cookieParser());

  app.use((request: Request, response: Response, next: NextFunction) => {
    requestContext.run(() => {
      const ctx = requestContext.getStore();
      if (ctx) {
        (request as Request & { correlationId?: string }).correlationId =
          ctx.correlationId;
        response.setHeader('X-Correlation-ID', ctx.correlationId);
      }
      next();
    }, request.get('x-correlation-id') ?? undefined);
  });

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: config.get('app.apiVersion', { infer: true }),
  });

  app.use((request: Request, _response: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();

    const path = request.path;
    if (CSRF_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
      return next();

    const csrfCookie = config.get('auth.csrfCookieName', { infer: true });
    const usesCookies = Boolean(
      request.cookies?.[config.get('auth.cookieName', { infer: true })] ||
      request.cookies?.[config.get('auth.refreshCookieName', { infer: true })],
    );
    if (
      usesCookies &&
      request.get('x-csrf-token') !== request.cookies?.[csrfCookie]
    ) {
      return next(new ForbiddenException('Invalid CSRF token'));
    }
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (config.get('monitoring.provider', { infer: true }) === 'sentry') {
    app.useGlobalFilters(
      new SentryGlobalFilter(app.get(HttpAdapterHost).httpAdapter),
    );
  }

  if (config.get('app.swaggerEnabled', { infer: true })) {
    const apiVersion = config.get('app.apiVersion', { infer: true });
    const swagger = new DocumentBuilder()
      .setTitle('Global Storage API')
      .setVersion(apiVersion)
      .addBearerAuth()
      .addCookieAuth('access_token')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));
  }
}
