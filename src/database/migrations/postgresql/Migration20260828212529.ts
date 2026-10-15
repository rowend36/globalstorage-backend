import { Migration } from '@mikro-orm/migrations';

export class Migration20260828212529 extends Migration {

  override name = 'Migration20260828212529';

  override up(): void | Promise<void> {
    this.addSql(`alter table "audit_events" alter column "tenant_id" drop not null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "audit_events" alter column "tenant_id" set not null;`);
  }

}
