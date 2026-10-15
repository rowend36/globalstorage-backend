import type { TriggerDef } from '@mikro-orm/core';

export const auditPostgresqlTriggers: TriggerDef[] = [
  {
    name: 'audit_events_immutable_update',
    timing: 'before',
    events: ['update'],
    forEach: 'row',
    body: "RAISE EXCEPTION 'audit_events are immutable'; RETURN NEW;",
  },
  {
    name: 'audit_events_immutable_delete',
    timing: 'before',
    events: ['delete'],
    forEach: 'row',
    body: "RAISE EXCEPTION 'audit_events are immutable'; RETURN OLD;",
  },
];
