import type { TriggerDef } from '@mikro-orm/core';

export const auditSqlite3Triggers: TriggerDef[] = [
  {
    name: 'audit_events_immutable_update',
    timing: 'before',
    events: ['update'],
    forEach: 'row',
    body: "SELECT RAISE(ABORT, 'audit_events are immutable');",
  },
  {
    name: 'audit_events_immutable_delete',
    timing: 'before',
    events: ['delete'],
    forEach: 'row',
    body: "SELECT RAISE(ABORT, 'audit_events are immutable');",
  },
];
