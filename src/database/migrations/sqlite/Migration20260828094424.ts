import { Migration } from '@mikro-orm/migrations';

export class Migration20260828094424 extends Migration {

  override name = 'Migration20260828094424';

  override up(): void | Promise<void> {
    this.addSql(`create trigger \`audit_events_immutable_update\` BEFORE UPDATE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);
    this.addSql(`create trigger \`audit_events_immutable_delete\` BEFORE DELETE on \`audit_events\` for each ROW begin SELECT RAISE(ABORT, 'audit_events are immutable'); end;`);

    this.addSql(`alter table \`users\` add column \`name\` text null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists \`audit_events_immutable_update\`;`);
    this.addSql(`drop trigger if exists \`audit_events_immutable_delete\`;`);

    this.addSql(`alter table \`users\` drop column \`name\`;`);
  }

}
