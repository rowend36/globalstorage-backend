import { Migration } from '@mikro-orm/migrations';

export class Migration20261015193938 extends Migration {

  override name = 'Migration20261015193938';

  override up(): void | Promise<void> {
    this.addSql(`alter table "space_keys" add "deleted_at" timestamptz null;`);
    this.addSql(`alter table "space_keys" alter column "last_persisted_version" type bigint using ("last_persisted_version"::bigint);`);
    this.addSql(`alter table "space_keys" alter column "last_persisted_version" set default '0';`);
    this.addSql(`alter table "space_keys" alter column "version" type bigint using ("version"::bigint);`);
    this.addSql(`alter table "space_keys" alter column "version" set default '1';`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "space_keys" drop column "deleted_at";`);
    this.addSql(`alter table "space_keys" alter column "version" type int using ("version"::int);`);
    this.addSql(`alter table "space_keys" alter column "version" set default 1;`);
    this.addSql(`alter table "space_keys" alter column "last_persisted_version" type int using ("last_persisted_version"::int);`);
    this.addSql(`alter table "space_keys" alter column "last_persisted_version" set default 0;`);
  }

}
