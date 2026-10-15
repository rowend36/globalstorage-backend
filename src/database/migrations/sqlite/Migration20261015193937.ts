import { Migration } from '@mikro-orm/migrations';

export class Migration20261015193937 extends Migration {

  override name = 'Migration20261015193937';

  override up(): void | Promise<void> {
    this.addSql(`drop trigger if exists \`audit_events_immutable_update\`;`);
    this.addSql(`drop trigger if exists \`audit_events_immutable_delete\`;`);
    this.addSql(`create trigger \`audit_events_immutable_update\` BEFORE UPDATE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`create trigger \`audit_events_immutable_delete\` BEFORE DELETE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);

    this.addSql(`pragma foreign_keys = off;`);
    this.addSql(`create table \`space_keys__temp_alter\` (\`id\` text not null primary key, \`space_id\` text not null, \`key\` text not null, \`version\` bigint not null default '1', \`value\` blob not null, \`content_type\` text null, \`last_persisted_version\` bigint not null default '0', \`deleted_at\` datetime null, \`created_at\` datetime not null, \`updated_at\` datetime null, constraint \`space_keys_space_id_foreign\` foreign key (\`space_id\`) references \`spaces\` (\`id\`));`);
    this.addSql(`insert into \`space_keys__temp_alter\` select \`id\`, \`space_id\`, \`key\`, \`version\`, \`value\`, \`content_type\`, \`last_persisted_version\`, null as \`deleted_at\`, \`created_at\`, \`updated_at\` from \`space_keys\`;`);
    this.addSql(`drop table \`space_keys\`;`);
    this.addSql(`alter table \`space_keys__temp_alter\` rename to \`space_keys\`;`);
    this.addSql(`create index \`space_keys_space_id_index\` on \`space_keys\` (\`space_id\`);`);
    this.addSql(`create unique index \`space_keys_space_id_key_unique\` on \`space_keys\` (\`space_id\`, \`key\`);`);
    this.addSql(`pragma foreign_keys = on;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists \`audit_events_immutable_update\`;`);
    this.addSql(`drop trigger if exists \`audit_events_immutable_delete\`;`);
    this.addSql(`create trigger \`audit_events_immutable_update\` BEFORE UPDATE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`create trigger \`audit_events_immutable_delete\` BEFORE DELETE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);

    this.addSql(`pragma foreign_keys = off;`);
    this.addSql(`create table \`space_keys__temp_alter\` (\`content_type\` text null, \`created_at\` datetime not null, \`id\` text not null primary key, \`key\` text not null, \`last_persisted_version\` integer not null default 0, \`space_id\` text not null, \`updated_at\` datetime null, \`value\` blob not null, \`version\` integer not null default 1, constraint \`space_keys_space_id_foreign\` foreign key (\`space_id\`) references \`spaces\` (\`id\`));`);
    this.addSql(`insert into \`space_keys__temp_alter\` select \`content_type\`, \`created_at\`, \`id\`, \`key\`, \`last_persisted_version\`, \`space_id\`, \`updated_at\`, \`value\`, \`version\` from \`space_keys\`;`);
    this.addSql(`drop table \`space_keys\`;`);
    this.addSql(`alter table \`space_keys__temp_alter\` rename to \`space_keys\`;`);
    this.addSql(`create index \`space_keys_space_id_index\` on \`space_keys\` (\`space_id\`);`);
    this.addSql(`create unique index \`space_keys_space_id_key_unique\` on \`space_keys\` (\`space_id\`, \`key\`);`);
    this.addSql(`pragma foreign_keys = on;`);
  }

}
