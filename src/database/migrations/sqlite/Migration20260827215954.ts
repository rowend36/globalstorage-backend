import { Migration } from '@mikro-orm/migrations';

export class Migration20260827215954 extends Migration {

  override name = 'Migration20260827215954';

  override up(): void | Promise<void> {
    this.addSql(`create table \`audit_events\` (\`id\` text not null primary key, \`tenant_id\` text not null, \`actor_id\` text null, \`action\` text not null, \`record_type\` text not null, \`record_id\` text not null, \`before\` json not null, \`after\` json not null, \`occurred_at\` datetime not null, \`request_id\` text null);`);

    this.addSql(`create table \`roles\` (\`id\` text not null primary key, \`name\` text not null, \`claims\` text not null, \`platform_role\` integer not null default false, \`version\` integer not null default 1);`);
    this.addSql(`create unique index \`roles_name_unique\` on \`roles\` (\`name\`);`);

    this.addSql(`create table \`tenants\` (\`id\` text not null primary key, \`slug\` text not null, \`name\` text not null, \`path\` text not null, \`mfa_policy\` text not null default 'any', \`parent_id\` text null, \`deleted_at\` datetime null, constraint \`tenants_parent_id_foreign\` foreign key (\`parent_id\`) references \`tenants\` (\`id\`) on delete set null);`);
    this.addSql(`create unique index \`tenants_slug_unique\` on \`tenants\` (\`slug\`);`);
    this.addSql(`create unique index \`tenants_path_unique\` on \`tenants\` (\`path\`);`);
    this.addSql(`create index \`tenants_parent_id_index\` on \`tenants\` (\`parent_id\`);`);

    this.addSql(`create table \`tenant_oidc_configs\` (\`id\` text not null primary key, \`tenant_id\` text not null, \`issuer\` text not null, \`client_id\` text not null, \`client_secret\` text not null, \`membership_claim\` text null, \`membership_value\` text null, \`allowed_email_domain\` text null, \`enabled\` integer not null default true, constraint \`tenant_oidc_configs_tenant_id_foreign\` foreign key (\`tenant_id\`) references \`tenants\` (\`id\`));`);
    this.addSql(`create index \`tenant_oidc_configs_tenant_id_index\` on \`tenant_oidc_configs\` (\`tenant_id\`);`);

    this.addSql(`create table \`users\` (\`id\` text not null primary key, \`email\` text not null, \`password_hash\` text not null, \`totp_secret\` text null, \`role_version\` integer not null default 1, \`deleted_at\` datetime null);`);
    this.addSql(`create unique index \`users_email_unique\` on \`users\` (\`email\`);`);

    this.addSql(`create table \`tenant_memberships\` (\`id\` text not null primary key, \`user_id\` text not null, \`tenant_id\` text not null, \`include_descendants\` integer not null default false, \`deleted_at\` datetime null, constraint \`tenant_memberships_user_id_foreign\` foreign key (\`user_id\`) references \`users\` (\`id\`), constraint \`tenant_memberships_tenant_id_foreign\` foreign key (\`tenant_id\`) references \`tenants\` (\`id\`));`);
    this.addSql(`create index \`tenant_memberships_user_id_index\` on \`tenant_memberships\` (\`user_id\`);`);
    this.addSql(`create index \`tenant_memberships_tenant_id_index\` on \`tenant_memberships\` (\`tenant_id\`);`);

    this.addSql(`create table \`membership_roles\` (\`id\` text not null primary key, \`membership_id\` text not null, \`role_id\` text not null, constraint \`membership_roles_membership_id_foreign\` foreign key (\`membership_id\`) references \`tenant_memberships\` (\`id\`), constraint \`membership_roles_role_id_foreign\` foreign key (\`role_id\`) references \`roles\` (\`id\`));`);
    this.addSql(`create index \`membership_roles_membership_id_index\` on \`membership_roles\` (\`membership_id\`);`);
    this.addSql(`create index \`membership_roles_role_id_index\` on \`membership_roles\` (\`role_id\`);`);

    this.addSql(`create table \`password_reset_tokens\` (\`id\` text not null primary key, \`user_id\` text not null, \`token_hash\` text not null, \`expires_at\` datetime not null, \`used_at\` datetime null, \`created_at\` datetime not null, constraint \`password_reset_tokens_user_id_foreign\` foreign key (\`user_id\`) references \`users\` (\`id\`));`);
    this.addSql(`create index \`password_reset_tokens_user_id_index\` on \`password_reset_tokens\` (\`user_id\`);`);
    this.addSql(`create unique index \`password_reset_tokens_token_hash_unique\` on \`password_reset_tokens\` (\`token_hash\`);`);

    this.addSql(`create table \`external_identities\` (\`id\` text not null primary key, \`user_id\` text not null, \`tenant_id\` text null, \`issuer\` text not null, \`subject\` text not null, constraint \`external_identities_user_id_foreign\` foreign key (\`user_id\`) references \`users\` (\`id\`), constraint \`external_identities_tenant_id_foreign\` foreign key (\`tenant_id\`) references \`tenants\` (\`id\`) on delete set null);`);
    this.addSql(`create index \`external_identities_user_id_index\` on \`external_identities\` (\`user_id\`);`);
    this.addSql(`create index \`external_identities_tenant_id_index\` on \`external_identities\` (\`tenant_id\`);`);

    this.addSql(`create table \`auth_sessions\` (\`id\` text not null primary key, \`user_id\` text not null, \`tenant_id\` text null, \`absolute_expires_at\` datetime not null, \`revoked_at\` datetime null, \`revoked_reason\` text null, \`created_at\` datetime not null, constraint \`auth_sessions_user_id_foreign\` foreign key (\`user_id\`) references \`users\` (\`id\`));`);
    this.addSql(`create index \`auth_sessions_user_id_index\` on \`auth_sessions\` (\`user_id\`);`);

    this.addSql(`create table \`refresh_tokens\` (\`id\` text not null primary key, \`session_id\` text not null, \`token_hash\` text not null, \`expires_at\` datetime not null, \`used_at\` datetime null, \`revoked_at\` datetime null, \`replaced_by_id\` text null, \`created_at\` datetime not null, constraint \`refresh_tokens_session_id_foreign\` foreign key (\`session_id\`) references \`auth_sessions\` (\`id\`));`);
    this.addSql(`create index \`refresh_tokens_session_id_index\` on \`refresh_tokens\` (\`session_id\`);`);
    this.addSql(`create unique index \`refresh_tokens_token_hash_unique\` on \`refresh_tokens\` (\`token_hash\`);`);
  }

  override down(): void | Promise<void> {

    this.addSql(`drop table if exists \`audit_events\`;`);
    this.addSql(`drop table if exists \`roles\`;`);
    this.addSql(`drop table if exists \`tenants\`;`);
    this.addSql(`drop table if exists \`tenant_oidc_configs\`;`);
    this.addSql(`drop table if exists \`users\`;`);
    this.addSql(`drop table if exists \`tenant_memberships\`;`);
    this.addSql(`drop table if exists \`membership_roles\`;`);
    this.addSql(`drop table if exists \`password_reset_tokens\`;`);
    this.addSql(`drop table if exists \`external_identities\`;`);
    this.addSql(`drop table if exists \`auth_sessions\`;`);
    this.addSql(`drop table if exists \`refresh_tokens\`;`);
  }

}
