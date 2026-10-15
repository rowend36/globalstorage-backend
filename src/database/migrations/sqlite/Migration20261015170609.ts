import { Migration } from '@mikro-orm/migrations';

export class Migration20261015170609 extends Migration {

  override name = 'Migration20261015170609';

  override up(): void | Promise<void> {
    this.addSql(`create table \`spaces\` (\`id\` text not null primary key, \`owner_id\` text not null, \`name\` text not null, \`quota_bytes\` integer not null default 52428800, \`used_bytes\` integer not null default 0, \`provider_type\` text not null default 'local', \`provider_config\` json null, \`state\` text not null default 'active', \`created_at\` datetime not null, \`updated_at\` datetime null, constraint \`spaces_owner_id_foreign\` foreign key (\`owner_id\`) references \`users\` (\`id\`));`);
    this.addSql(`create index \`spaces_owner_id_index\` on \`spaces\` (\`owner_id\`);`);

    this.addSql(`create table \`space_keys\` (\`id\` text not null primary key, \`space_id\` text not null, \`key\` text not null, \`version\` integer not null default 1, \`value\` blob not null, \`content_type\` text null, \`last_persisted_version\` integer not null default 0, \`created_at\` datetime not null, \`updated_at\` datetime null, constraint \`space_keys_space_id_foreign\` foreign key (\`space_id\`) references \`spaces\` (\`id\`));`);
    this.addSql(`create index \`space_keys_space_id_index\` on \`space_keys\` (\`space_id\`);`);
    this.addSql(`create unique index \`space_keys_space_id_key_unique\` on \`space_keys\` (\`space_id\`, \`key\`);`);

    this.addSql(`create table \`space_dictionaries\` (\`id\` text not null primary key, \`space_id\` text not null, \`version\` integer not null default 0, \`entries\` json not null, \`checksum\` text null, \`updated_at\` datetime null, constraint \`space_dictionaries_space_id_foreign\` foreign key (\`space_id\`) references \`spaces\` (\`id\`));`);
    this.addSql(`create index \`space_dictionaries_space_id_index\` on \`space_dictionaries\` (\`space_id\`);`);
    this.addSql(`create unique index \`space_dictionaries_space_id_unique\` on \`space_dictionaries\` (\`space_id\`);`);

    this.addSql(`create table \`space_blocks\` (\`id\` text not null primary key, \`space_id\` text not null, \`generation\` integer not null default 1, \`size_bytes\` integer not null default 0, \`checksum\` text not null, \`payload\` blob not null, \`state\` text not null default 'active', \`created_at\` datetime not null, constraint \`space_blocks_space_id_foreign\` foreign key (\`space_id\`) references \`spaces\` (\`id\`));`);
    this.addSql(`create index \`space_blocks_space_id_index\` on \`space_blocks\` (\`space_id\`);`);

    this.addSql(`drop trigger if exists \`audit_events_immutable_update\`;`);
    this.addSql(`drop trigger if exists \`audit_events_immutable_delete\`;`);
    this.addSql(`create trigger \`audit_events_immutable_update\` BEFORE UPDATE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`create trigger \`audit_events_immutable_delete\` BEFORE DELETE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
  }

  override down(): void | Promise<void> {

    this.addSql(`drop table if exists \`spaces\`;`);
    this.addSql(`drop table if exists \`space_keys\`;`);
    this.addSql(`drop table if exists \`space_dictionaries\`;`);
    this.addSql(`drop table if exists \`space_blocks\`;`);

    this.addSql(`drop trigger if exists \`audit_events_immutable_update\`;`);
    this.addSql(`drop trigger if exists \`audit_events_immutable_delete\`;`);
    this.addSql(`create trigger \`audit_events_immutable_update\` BEFORE UPDATE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`create trigger \`audit_events_immutable_delete\` BEFORE DELETE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
  }

}
