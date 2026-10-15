import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHmac, randomBytes, randomInt, randomUUID, createHash } from 'crypto';
import {
  AuthSessionSchema,
  RefreshTokenSchema,
  RoleSchema,
  TenantMembershipSchema,
  TenantSchema,
  UserSchema,
  PasswordResetTokenSchema,
  type AuthSession,
  type User,
} from '../database/entities';
import { AppConfig } from '../config/configuration';
import { CurrentUser } from './current-user';
import type { Cache } from 'cache-manager';
import { MfaService } from './mfa.service';
import { TemplatedMailService } from '../mail/templated-mail.service';
import { TelemetryService } from '../telemetry.service';
import { FieldEncryptionService } from '../security/field-encryption.service';

export type TokenPair = Readonly<{ accessToken: string; refreshToken: string }>;

export type MfaMethod = 'totp' | 'email';

const MFA_TOKEN_PURPOSE = 'mfa';
const MFA_EMAIL_TOKEN_PURPOSE = 'mfa-email';
const MFA_EMAIL_CODE_TTL_MS = 5 * 60 * 1000;

interface MfaTokenPayload {
  sub: string;
  purpose: typeof MFA_TOKEN_PURPOSE | typeof MFA_EMAIL_TOKEN_PURPOSE;
  jti?: string;
  tenantId?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly em: EntityManager,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly mfa: MfaService,
    private readonly mail: TemplatedMailService,
    private readonly telemetry: TelemetryService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  async validatePassword(email: string, password: string): Promise<User> {
    const user = await this.em.findOne(UserSchema, {
      email,
      deletedAt: null,
    });
    if (!user || !(await argon2.verify(user.passwordHash, password)))
      throw new UnauthorizedException('Invalid credentials');
    return user;
  }

  async mfaMethodsForUser(
    user: User,
    tenantSlug?: string,
  ): Promise<{
    methods: MfaMethod[];
    setupRequired?: 'totp';
    requiresTenant?: boolean;
    tenants?: Array<{ tenant: string; label: string }>;
    tenantId?: string;
  }> {
    const memberships = await this.em.find(
      TenantMembershipSchema,
      { user: user.id, deletedAt: null },
      { populate: ['tenant', 'roles.role'] },
    );
    const isPlatformUser = memberships.some((membership) =>
      membership.roles.getItems().some((assignment) => assignment.role.platformRole),
    );
    let tenantId: string | undefined;
    let policy: string;
    if (tenantSlug) {
      const tenant = await this.em.findOne(TenantSchema, { slug: tenantSlug, deletedAt: null });
      if (!tenant) throw new UnauthorizedException('Unknown tenant');
      if (!isPlatformUser && !memberships.some(({ tenant: memberTenant }) => memberTenant.id === tenant.id)) {
        throw new UnauthorizedException('User is not a member of this workspace');
      }
      tenantId = tenant.id;
      policy = tenant.mfaPolicy ?? 'any';
    } else if (isPlatformUser) {
      policy = this.config.get('auth.platformMfaPolicy', { infer: true });
    } else if (memberships.length > 1) {
      return {
        methods: [],
        requiresTenant: true,
        tenants: memberships.map(({ tenant }) => ({ tenant: tenant.slug, label: tenant.name })),
      };
    } else {
      tenantId = memberships[0]?.tenant.id;
      policy = memberships[0]?.tenant.mfaPolicy ?? 'any';
    }
    if (policy === 'totp' && !user.totpSecret) return { methods: [], setupRequired: 'totp', tenantId };
    if (policy === 'totp') return { methods: ['totp'], tenantId };
    if (policy === 'email') return { methods: ['email'], tenantId };
    return {
      methods: [
        ...(user.totpSecret ? (['totp'] as MfaMethod[]) : []),
        'email',
      ],
      tenantId,
    };
  }

  async getUserById(id: string): Promise<User> {
    const user = await this.em.findOne(UserSchema, { id, deletedAt: null });
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  async login(user: User, tenantId?: string): Promise<TokenPair> {
    const now = new Date();
    const session = this.em.create(AuthSessionSchema, {
      user,
      tenantId: tenantId ?? null,
      absoluteExpiresAt: new Date(
        now.getTime() +
          this.config.get('auth.sessionAbsoluteTtlSeconds', { infer: true }) *
            1000,
      ),
    });
    await this.em.flush();
    const pair = await this.issuePair(session, user, now);
    await this.em.flush();
    return pair;
  }

  async refresh(rawToken: string): Promise<TokenPair> {
    const pair = await this.em.transactional(async (transactionalEm) => {
      const token = await transactionalEm.findOne(
        RefreshTokenSchema,
        { tokenHash: this.hashRefresh(rawToken) },
        { populate: ['session.user'], lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!token) throw new UnauthorizedException('Invalid refresh token');
      const now = new Date();
      if (token.usedAt || token.revokedAt) {
        token.session.revokedAt = now;
        token.session.revokedReason = 'refresh_token_reuse';
        transactionalEm.persist(token.session);
        await transactionalEm.flush();
        return null;
      }
      if (
        token.expiresAt <= now ||
        token.session.absoluteExpiresAt <= now ||
        token.session.revokedAt ||
        token.session.user.deletedAt
      ) {
        throw new UnauthorizedException(
          'Refresh session is expired or revoked',
        );
      }
      token.usedAt = now;
      transactionalEm.persist(token);
      const pair = await this.issuePair(
        token.session,
        token.session.user,
        now,
        transactionalEm,
      );
      await transactionalEm.flush();
      return pair;
    });
    if (!pair) throw new UnauthorizedException('Refresh token reuse detected');
    return pair;
  }

  async validateSession(payload: CurrentUser): Promise<CurrentUser> {
    const session = await this.em.findOne(
      AuthSessionSchema,
      {
        id: payload.jti,
        revokedAt: null,
      },
      { populate: ['user'] },
    );
    if (
      !session ||
      session.absoluteExpiresAt <= new Date() ||
      session.user.deletedAt ||
      (session.tenantId ?? undefined) !== payload.tenantId ||
      (await this.cachedUserVersion(
        session.user.id,
        session.user.roleVersion,
      )) !== payload.userVersion
    ) {
      throw new UnauthorizedException(
        'Session is revoked or authorization is stale',
      );
    }
    const expected = payload.roles.flatMap((scope) => scope.versions);
    if (expected.length) {
      const roles = await this.em.find(RoleSchema, {
        id: { $in: expected.map((role) => role.id) },
      });
      const current = await Promise.all(
        expected.map(async (expectedRole) => ({
          expectedRole,
          version: await this.cachedRoleVersion(
            expectedRole.id,
            roles.find((role) => role.id === expectedRole.id)?.version,
          ),
        })),
      );
      if (
        roles.length !== expected.length ||
        current.some(
          ({ expectedRole, version }) => version !== expectedRole.version,
        )
      ) {
        throw new UnauthorizedException('Role claims are stale');
      }
    }
    return payload;
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    const session = await this.em.findOne(AuthSessionSchema, sessionId);
    if (session && !session.revokedAt) {
      session.revokedAt = new Date();
      session.revokedReason = reason;
      this.em.persist(session);
      await this.em.flush();
    }
  }

  async changePassword(
    user: User,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (!(await argon2.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    user.passwordHash = await argon2.hash(newPassword);
    this.em.persist(user);

    const sessions = await this.em.find(AuthSessionSchema, {
      user: user.id,
      revokedAt: null,
    });
    for (const session of sessions) {
      session.revokedAt = new Date();
      session.revokedReason = 'password_changed';
      this.em.persist(session);
    }
    await this.em.flush();
  }

  async requestPasswordReset(email: string): Promise<void> {
    return this.telemetry.run(
      'auth.password_reset.request',
      () => this.requestPasswordResetInternal(email),
      { 'auth.email_provided': Boolean(email) },
    );
  }

  private async requestPasswordResetInternal(email: string): Promise<void> {
    const user = await this.em.findOne(UserSchema, {
      email,
      deletedAt: null,
    });
    if (!user) return;

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('base64url');

    const existing = await this.em.findOne(PasswordResetTokenSchema, {
      user: user.id,
      usedAt: null,
    });
    if (existing) {
      existing.usedAt = new Date();
      this.em.persist(existing);
    }

    this.em.create(PasswordResetTokenSchema, {
      user,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await this.em.flush();

    await this.mail.send({
      to: user.email,
      subject: 'Reset your password',
      template: 'auth/password-reset.hbs',
      textTemplate: 'auth/password-reset.txt.hbs',
      context: {
        name: user.email,
        token: rawToken,
      },
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('base64url');
    const resetToken = await this.em.findOne(
      PasswordResetTokenSchema,
      { tokenHash, usedAt: null },
      { populate: ['user'] },
    );
    if (!resetToken || resetToken.expiresAt <= new Date()) {
      throw new NotFoundException('Invalid or expired reset token');
    }

    resetToken.usedAt = new Date();
    this.em.persist(resetToken);

    resetToken.user.passwordHash = await argon2.hash(newPassword);
    this.em.persist(resetToken.user);

    const sessions = await this.em.find(AuthSessionSchema, {
      user: resetToken.user.id,
      revokedAt: null,
    });
    for (const session of sessions) {
      session.revokedAt = new Date();
      session.revokedReason = 'password_reset';
      this.em.persist(session);
    }
    await this.em.flush();
  }

  async setupTotp(user: User): Promise<{ secret: string }> {
    const secret = this.mfa.createTotpSecret();
    user.totpSecret = this.encryption.encrypt(secret);
    this.em.persist(user);
    await this.em.flush();
    return { secret };
  }

  async verifyTotp(user: User, token: string): Promise<boolean> {
    if (!user.totpSecret) return false;
    const storedSecret = user.totpSecret;
    const secret = this.encryption.isEncrypted(storedSecret)
      ? this.encryption.decrypt(storedSecret)
      : storedSecret;
    const valid = await this.mfa.verifyTotp(token, secret);
    if (
      valid &&
      (!this.encryption.isEncrypted(storedSecret) ||
        !this.encryption.isCurrent(storedSecret))
    ) {
      user.totpSecret = this.encryption.encrypt(secret);
      this.em.persist(user);
      await this.em.flush();
    }
    return valid;
  }

  async authenticateWithMfa(
    mfaToken: string,
    totpCode: string,
  ): Promise<TokenPair> {
    const payload = this.jwt.verify<Partial<MfaTokenPayload>>(mfaToken, {
      secret: this.config.get('auth.jwtSecret', { infer: true }),
    });
    if (payload.purpose !== MFA_TOKEN_PURPOSE || !payload.sub) {
      throw new UnauthorizedException('Invalid MFA token');
    }
    const user = await this.em.findOne(UserSchema, {
      id: payload.sub,
      deletedAt: null,
    });
    if (!user || !user.totpSecret)
      throw new UnauthorizedException('Invalid MFA token');
    if (!(await this.verifyTotp(user, totpCode))) {
      throw new UnauthorizedException('Invalid TOTP code');
    }
    return this.login(user, payload.tenantId);
  }

  async beginEmailMfa(user: User, tenantId?: string): Promise<string> {
    const code = String(randomInt(100000, 1000000));
    const challengeId = randomUUID();
    const codeHash = createHash('sha256').update(code).digest('base64url');
    await this.cache.set(
      `mfa:email:${challengeId}`,
      { userId: user.id, codeHash },
      MFA_EMAIL_CODE_TTL_MS,
    );
    await this.mfa.sendEmailCode(user.email, code);
    return this.jwt.sign(
      { sub: user.id, purpose: MFA_EMAIL_TOKEN_PURPOSE, jti: challengeId, tenantId },
      { expiresIn: '5m' },
    );
  }

  async requestEmailMfa(mfaToken: string): Promise<string> {
    let payload: Partial<MfaTokenPayload>;
    try {
      payload = this.jwt.verify<Partial<MfaTokenPayload>>(mfaToken, {
        secret: this.config.get('auth.jwtSecret', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid MFA token');
    }
    if (payload.purpose !== MFA_TOKEN_PURPOSE || !payload.sub) {
      throw new UnauthorizedException('Invalid MFA token');
    }
    const user = await this.em.findOne(UserSchema, { id: payload.sub, deletedAt: null });
    if (!user) {
      throw new UnauthorizedException('Email MFA is unavailable');
    }
    return this.beginEmailMfa(user, payload.tenantId);
  }

  async authenticateWithEmailMfa(
    mfaToken: string,
    code: string,
  ): Promise<TokenPair> {
    let payload: Partial<MfaTokenPayload>;
    try {
      payload = this.jwt.verify<Partial<MfaTokenPayload>>(mfaToken, {
        secret: this.config.get('auth.jwtSecret', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid MFA token');
    }
    if (payload.purpose !== MFA_EMAIL_TOKEN_PURPOSE || !payload.sub || !payload.jti) {
      throw new UnauthorizedException('Invalid MFA token');
    }
    const challengeKey = `mfa:email:${payload.jti}`;
    const challenge = await this.cache.get<{ userId: string; codeHash: string }>(challengeKey);
    await this.cache.del(challengeKey);
    if (
      !challenge ||
      challenge.userId !== payload.sub ||
      createHash('sha256').update(code).digest('base64url') !== challenge.codeHash
    ) {
      throw new UnauthorizedException('Invalid MFA code');
    }
    const user = await this.em.findOne(UserSchema, { id: payload.sub, deletedAt: null });
    if (!user) throw new UnauthorizedException('Invalid MFA token');
    return this.login(user, payload.tenantId);
  }

  async setupTotpWithMfaToken(mfaToken: string): Promise<{ secret: string }> {
    const user = await this.userFromMfaToken(mfaToken);
    return this.setupTotp(user);
  }

  private async userFromMfaToken(mfaToken: string): Promise<User> {
    let payload: Partial<MfaTokenPayload>;
    try {
      payload = this.jwt.verify<Partial<MfaTokenPayload>>(mfaToken, {
        secret: this.config.get('auth.jwtSecret', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid MFA token');
    }
    if (payload.purpose !== MFA_TOKEN_PURPOSE || !payload.sub) {
      throw new UnauthorizedException('Invalid MFA token');
    }
    const user = await this.em.findOne(UserSchema, { id: payload.sub, deletedAt: null });
    if (!user) throw new UnauthorizedException('Invalid MFA token');
    return user;
  }

  async disableTotp(user: User, password: string): Promise<void> {
    if (!(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Password is incorrect');
    }
    user.totpSecret = null;
    this.em.persist(user);
    await this.em.flush();
  }

  private async issuePair(
    session: AuthSession,
    user: User,
    now: Date,
    entityManager: EntityManager = this.em,
  ): Promise<TokenPair> {
    const roles = await this.roleSnapshot(user.id, entityManager, session.tenantId ?? undefined);
    const accessToken = this.jwt.sign({
      sub: user.id,
      email: user.email,
      jti: session.id,
      userVersion: user.roleVersion,
      ...(session.tenantId ? { tenantId: session.tenantId } : {}),
      roles,
    } satisfies CurrentUser);
    const refreshToken = randomBytes(48).toString('base64url');
    const configuredExpiry = new Date(
      now.getTime() +
        this.config.get('auth.refreshIdleTtlSeconds', { infer: true }) * 1000,
    );
    const expiresAt =
      configuredExpiry < session.absoluteExpiresAt
        ? configuredExpiry
        : session.absoluteExpiresAt;
    entityManager.create(RefreshTokenSchema, {
      session,
      tokenHash: this.hashRefresh(refreshToken),
      expiresAt,
    });
    return { accessToken, refreshToken };
  }

  private async roleSnapshot(
    userId: string,
    entityManager: EntityManager,
    tenantId?: string,
  ): Promise<CurrentUser['roles']> {
    const memberships = await entityManager.find(
      TenantMembershipSchema,
      { user: userId, deletedAt: null },
      { populate: ['tenant', 'roles.role'] },
    );
    return memberships
      .filter((membership) => !tenantId || membership.tenant.id === tenantId)
      .map((membership) => {
      const assignments = membership.roles.getItems();
      return {
        tenantId: membership.tenant.id,
        tenantPath: membership.tenant.path,
        includeDescendants: membership.includeDescendants,
        names: assignments.map((assignment) => assignment.role.name),
        claims: [
          ...new Set(
            assignments
              .filter((assignment) => !assignment.role.platformRole)
              .flatMap((assignment) => assignment.role.claims),
          ),
        ],
        platformClaims: [
          ...new Set(
            assignments
              .filter((assignment) => assignment.role.platformRole)
              .flatMap((assignment) => assignment.role.claims),
          ),
        ],
        versions: assignments.map((assignment) => ({
          id: assignment.role.id,
          version: assignment.role.version,
        })),
      };
      });
  }

  private hashRefresh(token: string): string {
    return createHmac(
      'sha256',
      this.config.get('auth.refreshHashPepper', { infer: true }),
    )
      .update(token)
      .digest('base64url');
  }

  private async cachedUserVersion(
    userId: string,
    databaseVersion: number,
  ): Promise<number> {
    const key = `auth:user-version:${userId}`;
    const cached = await this.cache.get<number>(key);
    if (cached !== undefined) return cached;
    await this.cache.set(key, databaseVersion, 60_000);
    return databaseVersion;
  }

  private async cachedRoleVersion(
    roleId: string,
    databaseVersion: number | undefined,
  ): Promise<number | undefined> {
    const key = `auth:role-version:${roleId}`;
    const cached = await this.cache.get<number>(key);
    if (cached !== undefined) return cached;
    if (databaseVersion !== undefined)
      await this.cache.set(key, databaseVersion, 60_000);
    return databaseVersion;
  }
}
