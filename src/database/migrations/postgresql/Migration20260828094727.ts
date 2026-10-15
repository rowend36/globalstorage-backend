import { Migration } from '@mikro-orm/migrations';

export class Migration20260828094727 extends Migration {

  override name = 'Migration20260828094727';

  override up(): void | Promise<void> {
    this.addSql(`create table "audit_events" ("id" uuid not null, "tenant_id" uuid not null, "actor_id" uuid null, "action" varchar(255) not null, "record_type" varchar(255) not null, "record_id" uuid not null, "before" jsonb not null, "after" jsonb not null, "occurred_at" timestamptz not null, "request_id" uuid null, primary key ("id"));`);

    this.addSql(`create table "roles" ("id" uuid not null, "name" varchar(255) not null, "claims" varchar(255)[] not null, "platform_role" boolean not null default false, "version" int not null default 1, primary key ("id"));`);
    this.addSql(`alter table "roles" add constraint "roles_name_unique" unique ("name");`);

    this.addSql(`create table "tenants" ("id" uuid not null, "slug" varchar(255) not null, "name" varchar(255) not null, "path" varchar(255) not null, "mfa_policy" varchar(255) not null default 'any', "parent_id" uuid null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "tenants" add constraint "tenants_slug_unique" unique ("slug");`);
    this.addSql(`alter table "tenants" add constraint "tenants_path_unique" unique ("path");`);

    this.addSql(`create table "tenant_oidc_configs" ("id" uuid not null, "tenant_id" uuid not null, "issuer" varchar(255) not null, "client_id" varchar(255) not null, "client_secret" varchar(255) not null, "membership_claim" varchar(255) null, "membership_value" varchar(255) null, "allowed_email_domain" varchar(255) null, "enabled" boolean not null default true, primary key ("id"));`);

    this.addSql(`create table "users" ("id" uuid not null, "email" varchar(255) not null, "password_hash" varchar(255) not null, "totp_secret" varchar(255) null, "role_version" int not null default 1, "deleted_at" timestamptz null, "name" varchar(255) null, primary key ("id"));`);
    this.addSql(`alter table "users" add constraint "users_email_unique" unique ("email");`);

    this.addSql(`create table "tenant_memberships" ("id" uuid not null, "user_id" uuid not null, "tenant_id" uuid not null, "include_descendants" boolean not null default false, "deleted_at" timestamptz null, primary key ("id"));`);

    this.addSql(`create table "membership_roles" ("id" uuid not null, "membership_id" uuid not null, "role_id" uuid not null, primary key ("id"));`);

    this.addSql(`create table "password_reset_tokens" ("id" uuid not null, "user_id" uuid not null, "token_hash" varchar(255) not null, "expires_at" timestamptz not null, "used_at" timestamptz null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "password_reset_tokens" add constraint "password_reset_tokens_token_hash_unique" unique ("token_hash");`);

    this.addSql(`create table "external_identities" ("id" uuid not null, "user_id" uuid not null, "tenant_id" uuid null, "issuer" varchar(255) not null, "subject" varchar(255) not null, primary key ("id"));`);

    this.addSql(`create table "auth_sessions" ("id" uuid not null, "user_id" uuid not null, "tenant_id" uuid null, "absolute_expires_at" timestamptz not null, "revoked_at" timestamptz null, "revoked_reason" varchar(255) null, "created_at" timestamptz not null, primary key ("id"));`);

    this.addSql(`create table "refresh_tokens" ("id" uuid not null, "session_id" uuid not null, "token_hash" varchar(255) not null, "expires_at" timestamptz not null, "used_at" timestamptz null, "revoked_at" timestamptz null, "replaced_by_id" uuid null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "refresh_tokens" add constraint "refresh_tokens_token_hash_unique" unique ("token_hash");`);

    this.addSql(`create or replace function "audit_events_audit_events_immutable_update_fn"() returns trigger as \$\$ begin RAISE EXCEPTION 'audit_events are immutable'; RETURN NEW; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "audit_events_immutable_update" BEFORE UPDATE on "audit_events" for each ROW execute function "audit_events_audit_events_immutable_update_fn"();`);
    this.addSql(`create or replace function "audit_events_audit_events_immutable_delete_fn"() returns trigger as \$\$ begin RAISE EXCEPTION 'audit_events are immutable'; RETURN OLD; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "audit_events_immutable_delete" BEFORE DELETE on "audit_events" for each ROW execute function "audit_events_audit_events_immutable_delete_fn"();`);

    this.addSql(`alter table "tenants" add constraint "tenants_parent_id_foreign" foreign key ("parent_id") references "tenants" ("id") on delete set null;`);

    this.addSql(`alter table "tenant_oidc_configs" add constraint "tenant_oidc_configs_tenant_id_foreign" foreign key ("tenant_id") references "tenants" ("id");`);

    this.addSql(`alter table "tenant_memberships" add constraint "tenant_memberships_user_id_foreign" foreign key ("user_id") references "users" ("id");`);
    this.addSql(`alter table "tenant_memberships" add constraint "tenant_memberships_tenant_id_foreign" foreign key ("tenant_id") references "tenants" ("id");`);

    this.addSql(`alter table "membership_roles" add constraint "membership_roles_membership_id_foreign" foreign key ("membership_id") references "tenant_memberships" ("id");`);
    this.addSql(`alter table "membership_roles" add constraint "membership_roles_role_id_foreign" foreign key ("role_id") references "roles" ("id");`);

    this.addSql(`alter table "password_reset_tokens" add constraint "password_reset_tokens_user_id_foreign" foreign key ("user_id") references "users" ("id");`);

    this.addSql(`alter table "external_identities" add constraint "external_identities_user_id_foreign" foreign key ("user_id") references "users" ("id");`);
    this.addSql(`alter table "external_identities" add constraint "external_identities_tenant_id_foreign" foreign key ("tenant_id") references "tenants" ("id") on delete set null;`);

    this.addSql(`alter table "auth_sessions" add constraint "auth_sessions_user_id_foreign" foreign key ("user_id") references "users" ("id");`);

    this.addSql(`alter table "refresh_tokens" add constraint "refresh_tokens_session_id_foreign" foreign key ("session_id") references "auth_sessions" ("id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "membership_roles" drop constraint "membership_roles_role_id_foreign";`);
    this.addSql(`alter table "tenants" drop constraint "tenants_parent_id_foreign";`);
    this.addSql(`alter table "tenant_oidc_configs" drop constraint "tenant_oidc_configs_tenant_id_foreign";`);
    this.addSql(`alter table "tenant_memberships" drop constraint "tenant_memberships_tenant_id_foreign";`);
    this.addSql(`alter table "external_identities" drop constraint "external_identities_tenant_id_foreign";`);
    this.addSql(`alter table "tenant_memberships" drop constraint "tenant_memberships_user_id_foreign";`);
    this.addSql(`alter table "password_reset_tokens" drop constraint "password_reset_tokens_user_id_foreign";`);
    this.addSql(`alter table "external_identities" drop constraint "external_identities_user_id_foreign";`);
    this.addSql(`alter table "auth_sessions" drop constraint "auth_sessions_user_id_foreign";`);
    this.addSql(`alter table "membership_roles" drop constraint "membership_roles_membership_id_foreign";`);
    this.addSql(`alter table "refresh_tokens" drop constraint "refresh_tokens_session_id_foreign";`);

    this.addSql(`drop trigger if exists "audit_events_immutable_update" on "audit_events";`);
    this.addSql(`drop function if exists "audit_events_audit_events_immutable_update_fn"();`);
    this.addSql(`drop trigger if exists "audit_events_immutable_delete" on "audit_events";`);
    this.addSql(`drop function if exists "audit_events_audit_events_immutable_delete_fn"();`);
    this.addSql(`drop table if exists "audit_events" cascade;`);
    this.addSql(`drop table if exists "roles" cascade;`);
    this.addSql(`drop table if exists "tenants" cascade;`);
    this.addSql(`drop table if exists "tenant_oidc_configs" cascade;`);
    this.addSql(`drop table if exists "users" cascade;`);
    this.addSql(`drop table if exists "tenant_memberships" cascade;`);
    this.addSql(`drop table if exists "membership_roles" cascade;`);
    this.addSql(`drop table if exists "password_reset_tokens" cascade;`);
    this.addSql(`drop table if exists "external_identities" cascade;`);
    this.addSql(`drop table if exists "auth_sessions" cascade;`);
    this.addSql(`drop table if exists "refresh_tokens" cascade;`);
  }

}
