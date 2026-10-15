import { Migration } from '@mikro-orm/migrations';

export class Migration20261015170614 extends Migration {

  override name = 'Migration20261015170614';

  override up(): void | Promise<void> {
    this.addSql(`create table "spaces" ("id" uuid not null, "owner_id" uuid not null, "name" varchar(255) not null, "quota_bytes" int not null default 52428800, "used_bytes" int not null default 0, "provider_type" varchar(255) not null default 'local', "provider_config" jsonb null, "state" varchar(255) not null default 'active', "created_at" timestamptz not null, "updated_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "spaces_owner_id_index" on "spaces" ("owner_id");`);

    this.addSql(`create table "space_keys" ("id" uuid not null, "space_id" uuid not null, "key" varchar(255) not null, "version" int not null default 1, "value" bytea not null, "content_type" varchar(255) null, "last_persisted_version" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "space_keys_space_id_index" on "space_keys" ("space_id");`);
    this.addSql(`alter table "space_keys" add constraint "space_keys_space_id_key_unique" unique ("space_id", "key");`);

    this.addSql(`create table "space_dictionaries" ("id" uuid not null, "space_id" uuid not null, "version" int not null default 0, "entries" jsonb not null, "checksum" varchar(255) null, "updated_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "space_dictionaries" add constraint "space_dictionaries_space_id_unique" unique ("space_id");`);

    this.addSql(`create table "space_blocks" ("id" uuid not null, "space_id" uuid not null, "generation" int not null default 1, "size_bytes" int not null default 0, "checksum" varchar(255) not null, "payload" bytea not null, "state" varchar(255) not null default 'active', "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "space_blocks_space_id_index" on "space_blocks" ("space_id");`);

    this.addSql(`alter table "spaces" add constraint "spaces_owner_id_foreign" foreign key ("owner_id") references "users" ("id");`);

    this.addSql(`alter table "space_keys" add constraint "space_keys_space_id_foreign" foreign key ("space_id") references "spaces" ("id");`);

    this.addSql(`alter table "space_dictionaries" add constraint "space_dictionaries_space_id_foreign" foreign key ("space_id") references "spaces" ("id");`);

    this.addSql(`alter table "space_blocks" add constraint "space_blocks_space_id_foreign" foreign key ("space_id") references "spaces" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "space_keys" drop constraint "space_keys_space_id_foreign";`);
    this.addSql(`alter table "space_dictionaries" drop constraint "space_dictionaries_space_id_foreign";`);
    this.addSql(`alter table "space_blocks" drop constraint "space_blocks_space_id_foreign";`);

    this.addSql(`drop table if exists "spaces" cascade;`);
    this.addSql(`drop table if exists "space_keys" cascade;`);
    this.addSql(`drop table if exists "space_dictionaries" cascade;`);
    this.addSql(`drop table if exists "space_blocks" cascade;`);
  }

}
