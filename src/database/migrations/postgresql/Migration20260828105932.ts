import { Migration } from '@mikro-orm/migrations';

export class Migration20260828105932 extends Migration {

  override name = 'Migration20260828105932';

  override up(): void | Promise<void> {
    this.addSql(`create index "tenants_parent_id_index" on "tenants" ("parent_id");`);

    this.addSql(`create index "tenant_oidc_configs_tenant_id_index" on "tenant_oidc_configs" ("tenant_id");`);

    this.addSql(`create index "tenant_memberships_user_id_index" on "tenant_memberships" ("user_id");`);
    this.addSql(`create index "tenant_memberships_tenant_id_index" on "tenant_memberships" ("tenant_id");`);

    this.addSql(`create index "membership_roles_membership_id_index" on "membership_roles" ("membership_id");`);
    this.addSql(`create index "membership_roles_role_id_index" on "membership_roles" ("role_id");`);

    this.addSql(`create index "password_reset_tokens_user_id_index" on "password_reset_tokens" ("user_id");`);

    this.addSql(`create index "external_identities_user_id_index" on "external_identities" ("user_id");`);
    this.addSql(`create index "external_identities_tenant_id_index" on "external_identities" ("tenant_id");`);

    this.addSql(`create index "auth_sessions_user_id_index" on "auth_sessions" ("user_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "auth_sessions_user_id_index";`);

    this.addSql(`drop index "external_identities_user_id_index";`);
    this.addSql(`drop index "external_identities_tenant_id_index";`);

    this.addSql(`drop index "membership_roles_membership_id_index";`);
    this.addSql(`drop index "membership_roles_role_id_index";`);

    this.addSql(`drop index "password_reset_tokens_user_id_index";`);

    this.addSql(`drop index "tenant_memberships_user_id_index";`);
    this.addSql(`drop index "tenant_memberships_tenant_id_index";`);

    this.addSql(`drop index "tenant_oidc_configs_tenant_id_index";`);

    this.addSql(`drop index "tenants_parent_id_index";`);
  }

}
