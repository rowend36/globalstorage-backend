import { Global, Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { ObservabilityLifecycle } from './observability.lifecycle';

@Global()
@Module({
  providers: [TelemetryService, ObservabilityLifecycle],
  exports: [TelemetryService],
})
export class ObservabilityModule {}
