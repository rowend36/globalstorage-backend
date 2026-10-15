import { EntityManager } from '@mikro-orm/core';
import { Command, CommandRunner, Option } from 'nest-commander';
import * as argon2 from 'argon2';
import {
  MembershipRoleSchema,
  RoleSchema,
  TenantMembershipSchema,
  TenantSchema,
  UserSchema,
} from '../database/entities';
import {
  PLATFORM_ROLE_CLAIMS,
  PLATFORM_ROLE_NAME,
  PLATFORM_TENANT_SLUG,
} from '../authorization/platform.constants';

interface CreateSuperAdminOptions {
  email: string;
  name?: string;
}

@Command({
  name: 'create-super-admin',
  description: 'Create or complete the platform super-admin account',
})
export class SuperAdminCommand extends CommandRunner {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async run(_passedParams: string[], options: CreateSuperAdminOptions): Promise<void> {
    const em = this.em.fork();
    const email = options.email.trim().toLowerCase();
    if (!email.includes('@')) throw new Error('A valid email address is required');

    const existingUser = await em.findOne(UserSchema, { email });
    if (existingUser?.deletedAt) throw new Error('A deleted user already uses this email');
    const password = existingUser ? undefined : await this.promptSecret('Password: ');
    if (!existingUser && password !== await this.promptSecret('Confirm password: ')) {
      throw new Error('Passwords do not match');
    }
    if (password !== undefined && password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }

    await em.transactional(async (em) => {
      let tenant = await em.findOne(TenantSchema, { slug: PLATFORM_TENANT_SLUG });
      if (!tenant) {
        tenant = em.create(TenantSchema, {
          slug: PLATFORM_TENANT_SLUG,
          name: 'Platform',
          path: PLATFORM_TENANT_SLUG,
          mfaPolicy: 'any',
          parent: null,
          deletedAt: null,
        });
      } else if (
        tenant.deletedAt ||
        tenant.path !== PLATFORM_TENANT_SLUG ||
        tenant.parent
      ) {
        throw new Error('The reserved platform tenant is not a root tenant');
      }

      let role = await em.findOne(RoleSchema, { name: PLATFORM_ROLE_NAME });
      if (!role) {
        role = em.create(RoleSchema, {
          name: PLATFORM_ROLE_NAME,
          claims: PLATFORM_ROLE_CLAIMS,
          platformRole: true,
          version: 1,
        });
      } else if (!role.platformRole) {
        throw new Error(`Role ${PLATFORM_ROLE_NAME} exists but is not a platform role`);
      } else {
        const claims = [...new Set([...role.claims, ...PLATFORM_ROLE_CLAIMS])];
        if (claims.length !== role.claims.length) {
          role.claims = claims;
          role.version += 1;
        }
      }

      const user = existingUser ?? em.create(UserSchema, {
        email,
        passwordHash: await argon2.hash(password!),
        roleVersion: 1,
        deletedAt: null,
        name: options.name?.trim() || null,
        totpSecret: null,
      });
      if (existingUser && options.name !== undefined) user.name = options.name.trim() || null;
      em.persist(user);

      let membership = await em.findOne(TenantMembershipSchema, {
        user: user.id,
        tenant: tenant.id,
        deletedAt: null,
      });
      if (!membership) {
        membership = em.create(TenantMembershipSchema, {
          user,
          tenant,
          includeDescendants: false,
          deletedAt: null,
        });
        em.persist(membership);
      }

      const assignment = await em.findOne(MembershipRoleSchema, {
        membership: membership.id,
        role: role.id,
      });
      if (!assignment) em.create(MembershipRoleSchema, { membership, role });
      await em.flush();
    });

    console.log(`Platform super-admin ready: ${email}`);
  }

  @Option({ flags: '-e, --email <email>', description: 'Account email', required: true })
  parseEmail(value: string): string {
    return value;
  }

  @Option({ flags: '-n, --name <name>', description: 'Display name' })
  parseName(value: string): string {
    return value;
  }

  private promptSecret(prompt: string): Promise<string> {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) throw new Error('An interactive terminal is required for password input');
    return new Promise((resolve, reject) => {
      let value = '';
      const cleanup = () => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
      };
      const onData = (chunk: string) => {
        if (chunk === '\u0003') {
          cleanup();
          reject(new Error('Password input cancelled'));
        } else if (chunk === '\r' || chunk === '\n') {
          cleanup();
          resolve(value);
        } else if (chunk === '\u007f') {
          value = value.slice(0, -1);
        } else {
          value += chunk;
        }
      };
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdout.write(prompt);
    });
  }
}
