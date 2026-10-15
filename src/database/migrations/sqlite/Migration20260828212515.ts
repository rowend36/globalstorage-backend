import { Migration } from '@mikro-orm/migrations';

export class Migration20260828212515 extends Migration {

  override name = 'Migration20260828212515';

  override up(): void | Promise<void> {
    this.addSql(`pragma foreign_keys = off;`);
    this.addSql(`create table \`audit_events__temp_alter\` (\`id\` text not null primary key, \`tenant_id\` text null, \`actor_id\` text null, \`action\` text not null, \`record_type\` text not null, \`record_id\` text not null, \`before\` json not null, \`after\` json not null, \`occurred_at\` datetime not null, \`request_id\` text null);`);
    this.addSql(`insert into \`audit_events__temp_alter\` select \`id\`, \`tenant_id\`, \`actor_id\`, \`action\`, \`record_type\`, \`record_id\`, \`before\`, \`after\`, \`occurred_at\`, \`request_id\` from \`audit_events\`;`);
    this.addSql(`drop table \`audit_events\`;`);
    this.addSql(`alter table \`audit_events__temp_alter\` rename to \`audit_events\`;`);
    this.addSql(`create trigger \`audit_events_immutable_update\` BEFORE UPDATE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`create trigger \`audit_events_immutable_delete\` BEFORE DELETE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`pragma foreign_keys = on;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`pragma foreign_keys = off;`);
    this.addSql(`create table \`audit_events__temp_alter\` (\`action\` text not null, \`actor_id\` text null, \`after\` json not null, \`before\` json not null, \`id\` text not null primary key, \`occurred_at\` datetime not null, \`record_id\` text not null, \`record_type\` text not null, \`request_id\` text null, \`tenant_id\` text not null);`);
    this.addSql(`insert into \`audit_events__temp_alter\` select \`action\`, \`actor_id\`, \`after\`, \`before\`, \`id\`, \`occurred_at\`, \`record_id\`, \`record_type\`, \`request_id\`, \`tenant_id\` from \`audit_events\`;`);
    this.addSql(`drop table \`audit_events\`;`);
    this.addSql(`alter table \`audit_events__temp_alter\` rename to \`audit_events\`;`);
    this.addSql(`create trigger \`audit_events_immutable_update\` BEFORE UPDATE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`create trigger \`audit_events_immutable_delete\` BEFORE DELETE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`pragma foreign_keys = on;`);
  }

}
