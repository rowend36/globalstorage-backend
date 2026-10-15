import { Migration } from '@mikro-orm/migrations';

export class Migration20261015185743 extends Migration {

  override name = 'Migration20261015185743';

  override up(): void | Promise<void> {
    this.addSql(`drop table if exists \`space_blocks\`;`);
    this.addSql(`drop table if exists \`space_dictionaries\`;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`create table \`space_blocks\` (\`checksum\` text not null, \`created_at\` datetime not null, \`generation\` integer not null default 1, \`id\` text not null primary key, \`payload\` blob not null, \`size_bytes\` integer not null default 0, \`space_id\` text not null, \`state\` text not null default 'active', constraint \`space_blocks_space_id_foreign\` foreign key (\`space_id\`) references \`spaces\` (\`id\`));`);
    this.addSql(`create index \`space_blocks_space_id_index\` on \`space_blocks\` (\`space_id\`);`);

    this.addSql(`create table \`space_dictionaries\` (\`checksum\` text null, \`entries\` json not null, \`id\` text not null primary key, \`persisted_version\` integer not null default 0, \`space_id\` text not null, \`updated_at\` datetime null, \`version\` integer not null default 0, constraint \`space_dictionaries_space_id_foreign\` foreign key (\`space_id\`) references \`spaces\` (\`id\`));`);
    this.addSql(`create index \`space_dictionaries_space_id_index\` on \`space_dictionaries\` (\`space_id\`);`);
    this.addSql(`create unique index \`space_dictionaries_space_id_unique\` on \`space_dictionaries\` (\`space_id\`);`);
  }

}
