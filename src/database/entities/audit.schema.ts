import {
  defineEntity,
  type InferEntity,
  type TriggerDef,
  p,
} from '@mikro-orm/core';
import type { Driver } from '../../config/configuration';
import { uuid } from './helpers';
import { auditTriggersFor } from '../triggers';

export const createAuditEventSchema = (triggers: TriggerDef[]) =>
  defineEntity({
    name: 'AuditEvent',
    tableName: 'audit_events',
    properties: {
      id: uuid(),
      tenantId: p.uuid().nullable(),
      actorId: p.uuid().nullable(),
      action: p.string(),
      recordType: p.string(),
      recordId: p.uuid(),
      before: p.json<Record<string, unknown>>(),
      after: p.json<Record<string, unknown>>(),
      occurredAt: p.datetime().onCreate(() => new Date()),
      requestId: p.uuid().nullable(),
    },
    triggers,
  });

export const AuditEventSchema = createAuditEventSchema(
  auditTriggersFor((process.env.DATABASE_DRIVER ?? 'sqlite') as Driver),
);
export type AuditEvent = InferEntity<typeof AuditEventSchema>;
