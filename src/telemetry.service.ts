import { Injectable } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';

@Injectable()
export class TelemetryService {
  private readonly tracer = trace.getTracer('globalstorage-backend');

  async run<T>(
    name: string,
    operation: () => Promise<T>,
    attributes: Record<string, string | number | boolean> = {},
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await operation();
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
