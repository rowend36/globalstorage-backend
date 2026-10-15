import { initializeObservability } from './observability';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApplication } from './bootstrap';
import { Logger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from './config/configuration';

async function bootstrap() {
  initializeObservability();
  const app = await NestFactory.create(AppModule);
  app.useLogger(app.get(Logger));
  configureApplication(app);
  app.enableShutdownHooks();
  const config = app.get(ConfigService<AppConfig, true>);
  await app.listen(config.get('app.port', { infer: true }));
}
void bootstrap();
