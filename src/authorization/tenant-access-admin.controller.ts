import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ArrayNotEmpty, IsArray, IsString, IsUUID } from 'class-validator';
import { RequireClaims } from './claims.decorator';
import { TenantAccessAdminService } from './tenant-access-admin.service';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiProperty, ApiTags } from '@nestjs/swagger';

class ClaimsDto {
  @ApiProperty({ type: [String], example: ['roles.manage'] })
  @IsArray() @IsString({ each: true }) claims!: string[];
}
class RoleIdsDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true }) roleIds!: string[];
}

@Controller('access')
@UseGuards(AuthGuard('jwt'))
@ApiTags('authorization')
@ApiBearerAuth()
export class TenantAccessAdminController {
  constructor(private readonly access: TenantAccessAdminService) {}

  @Put('roles/:roleId/claims')
  @RequireClaims('roles.manage')
  @ApiOperation({ summary: 'Replace role claims' })
  @ApiParam({ name: 'roleId', format: 'uuid' })
  @ApiBody({ type: ClaimsDto })
  @ApiOkResponse({ description: 'Role claims replaced' })
  replaceClaims(
    @Param('roleId', new ParseUUIDPipe()) roleId: string,
    @Body() body: ClaimsDto,
  ) {
    return this.access.replaceRoleClaims(roleId, body.claims);
  }

  @Put('memberships/:membershipId/roles')
  @RequireClaims('roles.manage')
  @ApiOperation({ summary: 'Replace membership roles' })
  @ApiParam({ name: 'membershipId', format: 'uuid' })
  @ApiBody({ type: RoleIdsDto })
  @ApiOkResponse({ description: 'Membership roles replaced' })
  replaceMembershipRoles(
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Body() body: RoleIdsDto,
  ) {
    return this.access.replaceMembershipRoles(membershipId, body.roleIds);
  }
}
