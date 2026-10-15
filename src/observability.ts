import * as Sentry from '@sentry/nestjs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | undefined;
let sentryEnabled = false;

export function initializeObservability(): void {
  const monitoringProvider = process.env.MONITORING_PROVIDER ?? 'console';
  const dsn = process.env.SENTRY_DSN;
  if (monitoringProvider === 'sentry' && dsn) {
    Sentry.init({ dsn, tracesSampleRate: 0, sendDefaultPii: false });
    sentryEnabled = true;
  }

  const otelEnabled = process.env.OTEL_ENABLED === 'true';
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!otelEnabled || !endpoint) return;

  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'globalstorage-backend',
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
}

export async function shutdownObservability(): Promise<void> {
  await sdk?.shutdown();
  if (sentryEnabled) await Sentry.close(2_000);
}
