import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { shutdownObservability } from './observability';

@Injectable()
export class ObservabilityLifecycle implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownObservability();
  }
}
