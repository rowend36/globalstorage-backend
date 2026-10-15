import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';
import type { Response } from 'express';
import { AppConfig } from '../config/configuration';
import { OidcService } from './oidc.service';
import { deliverTokens } from '../auth/cookie.util';
import { RequireClaims } from '../authorization/claims.decorator';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

class OidcConfigDto {
  @ApiProperty({ format: 'uri' })
  @IsUrl() issuer!: string;
  @ApiProperty()
  @IsString() clientId!: string;
  @ApiProperty({ format: 'password' })
  @IsString() clientSecret!: string;
  @ApiPropertyOptional()
  @IsOptional() @IsString() membershipClaim?: string;
  @ApiPropertyOptional()
  @IsOptional() @IsString() membershipValue?: string;
  @ApiPropertyOptional()
  @IsOptional() @IsString() allowedEmailDomain?: string;
  @ApiPropertyOptional({ default: true })
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class OidcCallbackQuery {
  @ApiProperty()
  @IsString() code!: string;
  @ApiProperty()
  @IsString() state!: string;
}

class OidcConfigResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ format: 'uri' }) issuer!: string;
  @ApiProperty() clientId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) membershipClaim!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) membershipValue!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) allowedEmailDomain!: string | null;
  @ApiProperty() enabled!: boolean;
}

class OidcCallbackResponse {
  @ApiProperty() authenticated!: boolean;
}

@Controller('auth/oidc')
@ApiTags('oidc')
export class OidcController {
  constructor(
    private readonly oidc: OidcService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Get('login')
  @ApiOperation({ summary: 'Start an OIDC login flow' })
  @ApiQuery({ name: 'tenant', required: true })
  @ApiQuery({ name: 'config', required: false, format: 'uuid' })
  @ApiResponse({ status: 302, description: 'Redirects to the identity provider' })
  async login(
    @Query('tenant') tenant: string,
    @Query('config') config: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    response.redirect((await this.oidc.authorizationUrl(tenant, config)).url);
  }

  @Get('callback')
  @ApiOperation({ summary: 'Complete an OIDC login flow' })
  @ApiQuery({ name: 'code', required: true })
  @ApiQuery({ name: 'state', required: true })
  @ApiOkResponse({ type: OidcCallbackResponse })
  async callback(
    @Query() query: OidcCallbackQuery,
    @Res({ passthrough: true }) response: Response,
  ) {
    const tokens = await this.oidc.login(query.code, query.state);
    const authConfig = this.config.get('auth', { infer: true });
    deliverTokens(tokens, response, {
      cookieName: authConfig.cookieName,
      refreshCookieName: authConfig.refreshCookieName,
      csrfCookieName: authConfig.csrfCookieName,
      cookieSecure: authConfig.cookieSecure,
    });
    return { authenticated: true };
  }

  @Post('tenants/:tenantId/configs')
  @UseGuards(AuthGuard('jwt'))
  @RequireClaims('oidc.manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create tenant OIDC configuration' })
  @ApiParam({ name: 'tenantId', format: 'uuid' })
  @ApiBody({ type: OidcConfigDto })
  @ApiOkResponse({ type: OidcConfigResponse })
  createConfig(@Param('tenantId') tenantId: string, @Body() body: OidcConfigDto) {
    return this.oidc.createConfig(tenantId, body);
  }
}
