import { Migration } from '@mikro-orm/migrations';

export class Migration20261015185744 extends Migration {

  override name = 'Migration20261015185744';

  override up(): void | Promise<void> {
    this.addSql(`drop table if exists "space_blocks" cascade;`);
    this.addSql(`drop table if exists "space_dictionaries" cascade;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`create table "space_blocks" ("checksum" varchar(255) not null, "created_at" timestamptz(6) not null, "generation" int not null default 1, "id" uuid not null, "payload" bytea not null, "size_bytes" int not null default 0, "space_id" uuid not null, "state" varchar(255) not null default 'active', primary key ("id"));`);
    this.addSql(`create index "space_blocks_space_id_index" on "space_blocks" ("space_id");`);

    this.addSql(`create table "space_dictionaries" ("checksum" varchar(255) null, "entries" jsonb not null, "id" uuid not null, "persisted_version" int not null default 0, "space_id" uuid not null, "updated_at" timestamptz(6) null, "version" int not null default 0, primary key ("id"));`);
    this.addSql(`alter table "space_dictionaries" add constraint "space_dictionaries_space_id_unique" unique ("space_id");`);

    this.addSql(`alter table "space_blocks" add constraint "space_blocks_space_id_foreign" foreign key ("space_id") references "spaces" ("id");`);

    this.addSql(`alter table "space_dictionaries" add constraint "space_dictionaries_space_id_foreign" foreign key ("space_id") references "spaces" ("id");`);
  }

}
