import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { EntityManager } from '@mikro-orm/core';
import { AppConfig } from '../config/configuration';
import { TenantSchema } from '../database/entities/schemas';
import { CurrentUser } from '../auth/current-user';
import { REQUIRED_CLAIMS } from './claims.decorator';

@Injectable()
export class ClaimsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly em: EntityManager,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  async canActivate(context: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_CLAIMS,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;
    const request = context.switchToHttp().getRequest<{
      user?: CurrentUser;
      headers: Record<string, string | undefined>;
    }>();
    if (!request.user) throw new UnauthorizedException();

    const unsatisfied = this.unsatisfiedAfterGlobalClaims(
      request.user,
      required,
    );
    if (unsatisfied.length === 0) return true;

    const tenantId = request.headers['x-tenant-id'];
    if (!tenantId)
      throw new ForbiddenException(
        'x-tenant-id is required for tenant-scoped access',
      );
    const tenant = await this.em.findOne(TenantSchema, tenantId);
    if (!tenant) throw new ForbiddenException('Unknown tenant');
    const claims = request.user.roles
      .filter(
        (role) =>
          role.tenantId === tenant.id ||
          (role.includeDescendants && tenant.path.startsWith(role.tenantPath)),
      )
      .flatMap((role) => role.claims);
    if (
      !unsatisfied.every(
        (claim) => claims.includes(claim) || claims.includes('*'),
      )
    )
      throw new ForbiddenException('Missing required claim');
    return true;
  }

  private unsatisfiedAfterGlobalClaims(
    user: CurrentUser,
    required: string[],
  ): string[] {
    const platformClaims = [
      ...new Set(user.roles.flatMap((scope) => scope.platformClaims)),
    ];
    const allowSuperuser = this.config.get(
      'authorization.allowSuperuserClaim',
      { infer: true },
    );
    const grantedGlobally = (claim: string) =>
      platformClaims.includes(claim) ||
      (allowSuperuser && platformClaims.includes('*'));
    return required.filter((claim) => !grantedGlobally(claim));
  }
}
