import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { AppConfig } from '../config/configuration';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user';
import {
  deliverTokens,
  clearAuthCookies,
  getCookieConfig,
} from './cookie.util';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../infrastructure/request-context';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';

class LoginDto {
  @ApiProperty({ example: 'admin@example.com' })
  @IsEmail() email!: string;
  @ApiProperty({ minLength: 8, format: 'password' })
  @IsString() @MinLength(8) password!: string;
  @ApiPropertyOptional({ description: 'Tenant slug when selecting a tenant context' })
  @IsOptional() @IsString() tenant?: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional() @IsBoolean() cookies: boolean = false;
}

class RefreshDto {
  @ApiPropertyOptional({ format: 'password' })
  @IsOptional() @IsString() refreshToken?: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional() @IsBoolean() cookies: boolean = false;
}

class ChangePasswordDto {
  @ApiProperty({ minLength: 8, format: 'password' })
  @IsString() @MinLength(8) currentPassword!: string;
  @ApiProperty({ minLength: 8, format: 'password' })
  @IsString() @MinLength(8) newPassword!: string;
}

class ForgotPasswordDto {
  @ApiProperty({ example: 'admin@example.com' })
  @IsEmail() email!: string;
}

class ResetPasswordDto {
  @ApiProperty()
  @IsString() token!: string;
  @ApiProperty({ minLength: 8, format: 'password' })
  @IsString() @MinLength(8) newPassword!: string;
}

class MfaTotpVerifyDto {
  @ApiProperty({ example: '123456', minLength: 6, maxLength: 6 })
  @IsString() code!: string;
}

class MfaTotpAuthenticateDto {
  @ApiProperty()
  @IsString() mfaToken!: string;
  @ApiProperty({ example: '123456', minLength: 6, maxLength: 6 })
  @IsString() code!: string;
}

class MfaEmailAuthenticateDto {
  @ApiProperty()
  @IsString() mfaToken!: string;
  @ApiProperty({ example: '123456', minLength: 6, maxLength: 6 })
  @IsString() code!: string;
}

class MfaEmailRequestDto {
  @ApiProperty()
  @IsString() mfaToken!: string;
}

class MfaSetupDto {
  @ApiProperty()
  @IsString() mfaToken!: string;
}

class MfaTotpDisableDto {
  @ApiProperty({ minLength: 8, format: 'password' })
  @IsString() @MinLength(8) password!: string;
}

class TenantOptionResponse {
  @ApiProperty() tenant!: string;
  @ApiProperty() label!: string;
}

class TokenPairResponse {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
}

class CookiesResponse {
  @ApiProperty() cookies!: boolean;
}

class LoginTenantResponse {
  @ApiProperty() requiresTenant!: boolean;
  @ApiProperty({ type: [TenantOptionResponse] }) tenants!: TenantOptionResponse[];
}

class MfaChallengeResponse {
  @ApiProperty() requiresMfa!: boolean;
  @ApiPropertyOptional({ enum: ['totp'] }) requiresSetup?: string;
  @ApiProperty({ enum: ['totp', 'email'], isArray: true }) methods!: string[];
  @ApiProperty() mfaToken!: string;
}

class EmailMfaRequestResponse {
  @ApiProperty() sent!: boolean;
  @ApiProperty() mfaToken!: string;
}

class BooleanResponse {
  @ApiProperty() changed?: boolean;
  @ApiProperty() disabled?: boolean;
  @ApiProperty() valid?: boolean;
  @ApiProperty() sent?: boolean;
  @ApiProperty() reset?: boolean;
}

class TotpSetupResponse {
  @ApiProperty() secret!: string;
}

@Controller('auth')
@ApiTags('auth')
@ApiExtraModels(
  TokenPairResponse,
  CookiesResponse,
  LoginTenantResponse,
  MfaChallengeResponse,
  TenantOptionResponse,
)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly audit: AuditService,
  ) {}

  @Post('login')
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(TokenPairResponse) },
        { $ref: getSchemaPath(CookiesResponse) },
        { $ref: getSchemaPath(LoginTenantResponse) },
        { $ref: getSchemaPath(MfaChallengeResponse) },
      ],
    },
  })
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = await this.auth.validatePassword(dto.email, dto.password);

    const mfa = await this.auth.mfaMethodsForUser(user, dto.tenant);
    if (mfa.requiresTenant) {
      return { requiresTenant: true, tenants: mfa.tenants };
    }
    const methods = mfa.methods;
    if (mfa.setupRequired) {
      return {
        requiresMfa: true,
        requiresSetup: mfa.setupRequired,
        methods,
        mfaToken: this.signMfaToken(user.id, mfa.tenantId),
      };
    }
    if (methods.length) {
      const mfaToken = this.signMfaToken(user.id, mfa.tenantId);
      return { requiresMfa: true, methods, mfaToken };
    }

    const tokens = await this.auth.login(user, mfa.tenantId);
    await this.audit.record({
      tenantId: await this.audit.scopeForActor(user.id, mfa.tenantId),
      actorId: user.id,
      action: 'auth.login',
      recordType: 'User',
      recordId: user.id,
      before: {},
      after: { method: 'password' },
      requestId: requestContext.getCorrelationId(),
    });
    if (dto.cookies) {
      deliverTokens(
        tokens,
        response,
        getCookieConfig(this.config.get('auth', { infer: true })),
      );
      return { cookies: true };
    }
    return tokens;
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh an access token' })
  @ApiBody({ type: RefreshDto })
  @ApiOkResponse({ schema: { oneOf: [{ $ref: getSchemaPath(TokenPairResponse) }, { $ref: getSchemaPath(CookiesResponse) }] } })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = dto.cookies
      ? (request.cookies?.[
          this.config.get('auth.refreshCookieName', { infer: true })
        ] as string | undefined)
      : dto.refreshToken;
    if (!refreshToken)
      throw new UnauthorizedException('Refresh token is required');
    const tokens = await this.auth.refresh(refreshToken);
    if (dto.cookies) {
      deliverTokens(
        tokens,
        response,
        getCookieConfig(this.config.get('auth', { infer: true })),
      );
      return { cookies: true };
    }
    return tokens;
  }

  @Post('logout')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Log out and revoke the current session' })
  @ApiOkResponse({ type: BooleanResponse })
  async logout(
    @Req() request: Request & { user: CurrentUser },
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.revoke(request.user.jti, 'logout');
    await this.audit.record({
      tenantId: await this.audit.scopeForActor(request.user.sub, request.user.tenantId),
      actorId: request.user.sub,
      action: 'auth.logout',
      recordType: 'User',
      recordId: request.user.sub,
      before: {},
      after: {},
      requestId: requestContext.getCorrelationId(),
    });
    clearAuthCookies(
      response,
      getCookieConfig(this.config.get('auth', { infer: true })),
    );
    return { loggedOut: true };
  }

  @Post('change-password')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiBody({ type: ChangePasswordDto })
  @ApiOkResponse({ type: BooleanResponse })
  async changePassword(
    @Req() request: Request & { user: CurrentUser },
    @Body() dto: ChangePasswordDto,
  ) {
    const user = await this.auth.validatePassword(
      request.user.email,
      dto.currentPassword,
    );
    await this.auth.changePassword(user, dto.currentPassword, dto.newPassword);
    await this.audit.record({
      tenantId: await this.audit.scopeForActor(request.user.sub, request.user.tenantId),
      actorId: request.user.sub,
      action: 'auth.password_changed',
      recordType: 'User',
      recordId: request.user.sub,
      before: {},
      after: {},
      requestId: requestContext.getCorrelationId(),
    });
    return { changed: true };
  }

  @Post('forgot-password')
  @ApiOperation({ summary: 'Request a password reset email' })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiOkResponse({ type: BooleanResponse })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.auth.requestPasswordReset(dto.email);
    return { sent: true };
  }

  @Post('reset-password')
  @ApiBody({ type: ResetPasswordDto })
  @ApiOkResponse({ type: BooleanResponse })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    await this.audit.record({
      tenantId: null,
      actorId: '',
      action: 'auth.password_reset',
      recordType: 'User',
      recordId: '',
      before: {},
      after: {},
      requestId: requestContext.getCorrelationId(),
    });
    return { reset: true };
  }

  @Post('mfa/totp/setup')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOkResponse({ type: TotpSetupResponse })
  async setupTotp(@Req() request: Request & { user: CurrentUser }) {
    const user = await this.auth.getUserById(request.user.sub);
    const result = await this.auth.setupTotp(user);
    await this.audit.record({
      tenantId: await this.audit.scopeForActor(request.user.sub, request.user.tenantId),
      actorId: request.user.sub,
      action: 'auth.mfa_setup',
      recordType: 'User',
      recordId: request.user.sub,
      before: { totpEnabled: false },
      after: { totpEnabled: true },
      requestId: requestContext.getCorrelationId(),
    });
    return result;
  }

  @Post('mfa/totp/setup-required')
  @ApiBody({ type: MfaSetupDto })
  @ApiOkResponse({ type: TotpSetupResponse })
  async setupRequiredTotp(@Body() dto: MfaSetupDto) {
    return this.auth.setupTotpWithMfaToken(dto.mfaToken);
  }

  @Post('mfa/totp/verify')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiBody({ type: MfaTotpVerifyDto })
  @ApiOkResponse({ type: BooleanResponse })
  async verifyTotp(
    @Req() request: Request & { user: CurrentUser },
    @Body() dto: MfaTotpVerifyDto,
  ) {
    const user = await this.auth.getUserById(request.user.sub);
    const valid = await this.auth.verifyTotp(user, dto.code);
    return { valid };
  }

  @Post('mfa/totp/authenticate')
  @ApiBody({ type: MfaTotpAuthenticateDto })
  @ApiOkResponse({ type: TokenPairResponse })
  async mfaAuthenticate(@Body() dto: MfaTotpAuthenticateDto) {
    const tokens = await this.auth.authenticateWithMfa(dto.mfaToken, dto.code);
    await this.audit.record({
      tenantId: null,
      actorId: '',
      action: 'auth.login',
      recordType: 'User',
      recordId: '',
      before: {},
      after: { method: 'mfa' },
      requestId: requestContext.getCorrelationId(),
    });
    return tokens;
  }

  @Post('mfa/email/request')
  @ApiBody({ type: MfaEmailRequestDto })
  @ApiOkResponse({ type: EmailMfaRequestResponse })
  async requestEmailMfa(@Body() dto: MfaEmailRequestDto) {
    const mfaToken = await this.auth.requestEmailMfa(dto.mfaToken);
    return { sent: true, mfaToken };
  }

  @Post('mfa/email/authenticate')
  @ApiBody({ type: MfaEmailAuthenticateDto })
  @ApiOkResponse({ type: TokenPairResponse })
  async mfaEmailAuthenticate(@Body() dto: MfaEmailAuthenticateDto) {
    const tokens = await this.auth.authenticateWithEmailMfa(dto.mfaToken, dto.code);
    await this.audit.record({
      tenantId: null,
      actorId: '',
      action: 'auth.login',
      recordType: 'User',
      recordId: '',
      before: {},
      after: { method: 'email_mfa' },
      requestId: requestContext.getCorrelationId(),
    });
    return tokens;
  }

  @Post('mfa/totp/disable')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiBody({ type: MfaTotpDisableDto })
  @ApiOkResponse({ type: BooleanResponse })
  async disableTotp(
    @Req() request: Request & { user: CurrentUser },
    @Body() dto: MfaTotpDisableDto,
  ) {
    const user = await this.auth.getUserById(request.user.sub);
    await this.auth.disableTotp(user, dto.password);
    await this.audit.record({
      tenantId: await this.audit.scopeForActor(request.user.sub, request.user.tenantId),
      actorId: request.user.sub,
      action: 'auth.mfa_disabled',
      recordType: 'User',
      recordId: request.user.sub,
      before: { totpEnabled: true },
      after: { totpEnabled: false },
      requestId: requestContext.getCorrelationId(),
    });
    return { disabled: true };
  }

  private signMfaToken(userId: string, tenantId?: string): string {
    return this.jwt.sign(
      { sub: userId, purpose: 'mfa', ...(tenantId ? { tenantId } : {}) },
      { expiresIn: '5m' },
    );
  }
}
