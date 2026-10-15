import { MikroORM } from '@mikro-orm/core';
import { configuration } from '../config/configuration';
import { mikroOrmOptions } from './mikro-orm.config';

async function run(): Promise<void> {
  const orm = await MikroORM.init(mikroOrmOptions(configuration()) as any);
  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
}

void run().catch((error: unknown) => {
  console.error('Database migration failed', error);
  process.exitCode = 1;
});
