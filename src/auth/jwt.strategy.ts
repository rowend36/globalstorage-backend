import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfig } from '../config/configuration';
import { CurrentUser } from './current-user';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly auth: AuthService,
  ) {
    const cookieName = config.get('auth.cookieName', { infer: true });
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request: Record<string, unknown> | undefined) =>
          (request?.cookies as Record<string, string> | undefined)?.[
            cookieName
          ] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: config.get('auth.jwtSecret', { infer: true }),
    });
  }

  validate(payload: CurrentUser): Promise<CurrentUser> {
    return this.auth.validateSession(payload);
  }
}
