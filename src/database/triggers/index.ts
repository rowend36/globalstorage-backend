import type { TriggerDef } from '@mikro-orm/core';
import type { Driver } from '../../config/configuration';
import { auditPostgresqlTriggers } from './audit.postgresql.triggers';
import { auditSqlite3Triggers } from './audit.sqlite3.triggers';

export const auditTriggersFor = (driver: Driver): TriggerDef[] =>
  driver === 'postgresql' ? auditPostgresqlTriggers : auditSqlite3Triggers;

export { auditPostgresqlTriggers } from './audit.postgresql.triggers';
export { auditSqlite3Triggers } from './audit.sqlite3.triggers';
