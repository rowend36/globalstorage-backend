import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/core';
import * as argon2 from 'argon2';
import {
  calculatePKCECodeChallenge,
  ClientSecretBasic,
  discovery,
  randomPKCECodeVerifier,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  type Configuration,
} from 'openid-client';
import type { Cache } from 'cache-manager';
import { randomBytes, randomUUID } from 'crypto';
import { AppConfig } from '../config/configuration';
import {
  ExternalIdentitySchema,
  TenantOidcConfigSchema,
  TenantSchema,
  TenantMembershipSchema,
  UserSchema,
} from '../database/entities';
import { AuthService, type TokenPair } from '../auth/auth.service';
import { FieldEncryptionService } from '../security/field-encryption.service';

interface OidcState {
  codeVerifier: string;
  configId: string;
}

type OidcClaims = Record<string, unknown> & {
  sub?: string;
  email?: string;
  email_verified?: boolean;
};

@Injectable()
export class OidcService {
  private readonly clients = new Map<string, Promise<Configuration>>();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly em: EntityManager,
    private readonly auth: AuthService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  async createConfig(
    tenantId: string,
    input: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      membershipClaim?: string;
      membershipValue?: string;
      allowedEmailDomain?: string;
      enabled?: boolean;
    },
  ) {
    const tenant = await this.em.findOne(TenantSchema, { id: tenantId, deletedAt: null });
    if (!tenant) throw new UnauthorizedException('Workspace is unavailable');
    if (
      !(input.membershipClaim && input.membershipValue) &&
      !input.allowedEmailDomain
    ) {
      throw new UnauthorizedException('An OIDC membership rule is required');
    }
    const config = this.em.create(TenantOidcConfigSchema, {
      tenant,
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecret: this.encryption.encrypt(input.clientSecret),
      membershipClaim: input.membershipClaim ?? null,
      membershipValue: input.membershipValue ?? null,
      allowedEmailDomain: input.allowedEmailDomain?.toLowerCase() ?? null,
      enabled: input.enabled ?? true,
    });
    await this.em.flush();
    return {
      id: config.id,
      tenantId,
      issuer: config.issuer,
      clientId: config.clientId,
      membershipClaim: config.membershipClaim,
      membershipValue: config.membershipValue,
      allowedEmailDomain: config.allowedEmailDomain,
      enabled: config.enabled,
    };
  }

  async authorizationUrl(tenantSlug: string, configId?: string): Promise<{ url: string; state: string }> {
    const tenant = await this.em.findOne(TenantSchema, { slug: tenantSlug, deletedAt: null });
    if (!tenant) throw new UnauthorizedException('OIDC workspace is unavailable');
    const oidc = await this.selectConfig(tenant.id, configId);
    const state = randomUUID();
    const codeVerifier = randomPKCECodeVerifier();
    await this.cache.set<OidcState>(`oidc:${state}`, { codeVerifier, configId: oidc.id }, 600_000);
    return {
      state,
      url: buildAuthorizationUrl(await this.client(oidc), {
        redirect_uri: this.redirectUri(),
        response_type: 'code',
        scope: this.config.get('oidc.scopes', { infer: true }),
        state,
        code_challenge: await calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
      }).href,
    };
  }

  async login(code: string, state: string): Promise<TokenPair> {
    const stored = await this.cache.get<OidcState>(`oidc:${state}`);
    await this.cache.del(`oidc:${state}`);
    if (!stored) throw new UnauthorizedException('OIDC state is invalid or expired');
    const oidc = await this.em.findOne(TenantOidcConfigSchema, { id: stored.configId, enabled: true }, { populate: ['tenant'] });
    if (!oidc || oidc.tenant.deletedAt) throw new UnauthorizedException('OIDC workspace is unavailable');

    const callback = new URL(this.redirectUri());
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', state);
    const tokens = await authorizationCodeGrant(await this.client(oidc), callback, {
      expectedState: state,
      pkceCodeVerifier: stored.codeVerifier,
    });
    const claims = (tokens.claims() ?? {}) as OidcClaims;
    if (!claims.sub) throw new UnauthorizedException('OIDC provider did not return a subject');

    const identity = await this.em.findOne(
      ExternalIdentitySchema,
      { issuer: oidc.issuer, subject: claims.sub, tenant: oidc.tenant.id },
      { populate: ['user'] },
    );
    if (identity?.user.deletedAt) {
      throw new UnauthorizedException('OIDC identity is not provisioned');
    }
    const user = identity?.user ?? null;
    if (user) {
      const membership = await this.em.findOne(TenantMembershipSchema, {
        user: user.id,
        tenant: oidc.tenant.id,
        deletedAt: null,
      });
      if (membership) return this.auth.login(user, oidc.tenant.id);
    }
    if (!this.isWorkspaceMember(oidc, claims)) {
      throw new UnauthorizedException('OIDC identity is not a member of this workspace');
    }
    if (!claims.email || claims.email_verified !== true) {
      throw new UnauthorizedException('OIDC provider must return a verified email');
    }

    const existingUser = await this.em.findOne(UserSchema, {
      email: claims.email,
      deletedAt: null,
    });
    if (existingUser && !user) {
      throw new UnauthorizedException('OIDC identity must be explicitly linked');
    }

    const provisionedUser = user ?? this.em.create(UserSchema, {
      email: claims.email,
      passwordHash: await argon2.hash(randomBytes(32).toString('base64url')),
    });
    if (!user) this.em.persist(provisionedUser);
    const membership = await this.em.findOne(TenantMembershipSchema, {
      user: provisionedUser.id,
      tenant: oidc.tenant.id,
      deletedAt: null,
    });
    if (!membership) this.em.create(TenantMembershipSchema, { user: provisionedUser, tenant: oidc.tenant });
    if (!identity) {
      this.em.create(ExternalIdentitySchema, {
        user: provisionedUser,
        tenant: oidc.tenant,
        issuer: oidc.issuer,
        subject: claims.sub,
      });
    }
    await this.em.flush();
    return this.auth.login(provisionedUser, oidc.tenant.id);
  }

  private isWorkspaceMember(
    oidc: { membershipClaim?: string | null; membershipValue?: string | null; allowedEmailDomain?: string | null },
    claims: OidcClaims,
  ): boolean {
    if (oidc.membershipClaim && oidc.membershipValue) {
      const value = claims[oidc.membershipClaim];
      if (value === oidc.membershipValue || (Array.isArray(value) && value.includes(oidc.membershipValue))) return true;
    }
    return Boolean(
      oidc.allowedEmailDomain && typeof claims.email === 'string' && claims.email_verified === true &&
      claims.email.toLowerCase().endsWith(`@${oidc.allowedEmailDomain.toLowerCase()}`),
    );
  }

  private async selectConfig(tenantId: string, configId?: string) {
    const direct = configId
      ? await this.em.findOne(TenantOidcConfigSchema, { id: configId, tenant: tenantId, enabled: true })
      : await this.em.findOne(TenantOidcConfigSchema, { tenant: tenantId, enabled: true });
    if (direct) return direct;
    const tenant = await this.em.findOne(TenantSchema, tenantId);
    if (!tenant) throw new UnauthorizedException('OIDC workspace is unavailable');
    let parentId = tenant.parent?.id;
    while (parentId) {
      const parentConfig = configId
        ? await this.em.findOne(TenantOidcConfigSchema, { id: configId, tenant: parentId, enabled: true })
        : await this.em.findOne(TenantOidcConfigSchema, { tenant: parentId, enabled: true });
      if (parentConfig) return parentConfig;
      const parent = await this.em.findOne(TenantSchema, parentId);
      parentId = parent?.parent?.id;
    }
    throw new UnauthorizedException('OIDC workspace is unavailable');
  }

  private redirectUri(): string {
    const redirectUri = this.config.get('oidc.redirectUri', { infer: true });
    if (!redirectUri) throw new Error('OIDC_REDIRECT_URI is required');
    return redirectUri;
  }

  private client(oidc: { id: string; issuer: string; clientId: string; clientSecret: string }): Promise<Configuration> {
    let client = this.clients.get(oidc.id);
    if (!client) {
      client = discovery(new URL(oidc.issuer), oidc.clientId, undefined, ClientSecretBasic(this.encryption.decrypt(oidc.clientSecret)));
      this.clients.set(oidc.id, client);
    }
    return client;
  }
}
