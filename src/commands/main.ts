import { CommandFactory } from 'nest-commander';
import { CommandsModule } from './commands.module';
import { initializeObservability } from '../observability';

async function bootstrap(): Promise<void> {
  initializeObservability();
  await CommandFactory.run(CommandsModule, {
    cliName: 'gs',
    logger: ['error', 'warn'],
  });
}

void bootstrap();
