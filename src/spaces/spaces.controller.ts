import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { StorageEngineService } from '../engine/engine.service';
import type { CurrentUser } from '../auth/current-user';

class CreateSpaceDto {
  @ApiProperty({ example: 'Todo App' })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 52428800, description: 'Defaults to 50 MB' })
  @IsOptional()
  @IsInt()
  @Min(1)
  quotaBytes?: number;
}

class UpdateSpaceDto {
  @ApiPropertyOptional({ example: 'Todo App' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 52428800 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quotaBytes?: number;
}

class SpaceResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() quotaBytes!: number;
  @ApiProperty() usedBytes!: number;
  @ApiProperty({ enum: ['active', 'unhealthy'] }) state!: string;
  @ApiProperty() providerType!: string;
}

class SpaceStatusResponse {
  @ApiProperty() spaceId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['active', 'unhealthy'] }) state!: string;
  @ApiProperty() quotaBytes!: number;
  @ApiProperty() usedBytes!: number;
  @ApiProperty() keyCount!: number;
  @ApiProperty() pendingKeys!: number;
  @ApiProperty() pendingBytes!: number;
}

@Controller('spaces')
@ApiTags('spaces')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class SpacesController {
  constructor(private readonly engine: StorageEngineService) {}

  @Get()
  @ApiOperation({ summary: 'List accessible spaces' })
  @ApiOkResponse({ type: [SpaceResponse] })
  async list(@Req() request: Request & { user: CurrentUser }): Promise<SpaceResponse[]> {
    return this.engine.listSpaces(request.user.sub);
  }

  @Post()
  @ApiOperation({ summary: 'Create a space' })
  @ApiCreatedResponse({ type: SpaceResponse })
  async create(
    @Req() request: Request & { user: CurrentUser },
    @Body() body: CreateSpaceDto,
  ): Promise<SpaceResponse> {
    return this.engine.createSpace(request.user.sub, body.name, body.quotaBytes);
  }

  @Get(':spaceId')
  @ApiOperation({ summary: 'Get space metadata' })
  @ApiOkResponse({ type: SpaceResponse })
  async get(
    @Req() request: Request & { user: CurrentUser },
    @Param('spaceId') spaceId: string,
  ): Promise<SpaceResponse> {
    return this.engine.getSpaceSummary(request.user.sub, spaceId);
  }

  @Patch(':spaceId')
  @ApiOperation({ summary: 'Update permitted space settings' })
  @ApiOkResponse({ type: SpaceResponse })
  async update(
    @Req() request: Request & { user: CurrentUser },
    @Param('spaceId') spaceId: string,
    @Body() body: UpdateSpaceDto,
  ): Promise<SpaceResponse> {
    return this.engine.updateSpace(request.user.sub, spaceId, {
      name: body.name,
      quotaBytes: body.quotaBytes,
    });
  }

  @Delete(':spaceId')
  @ApiOperation({ summary: 'Delete a space' })
  @ApiNoContentResponse({ description: 'Space deleted' })
  @HttpCode(204)
  async remove(
    @Req() request: Request & { user: CurrentUser },
    @Param('spaceId') spaceId: string,
  ): Promise<void> {
    await this.engine.deleteSpace(request.user.sub, spaceId);
  }

  @Get(':spaceId/status')
  @ApiOperation({ summary: 'Get persistence and health status' })
  @ApiOkResponse({ type: SpaceStatusResponse })
  async status(
    @Req() request: Request & { user: CurrentUser },
    @Param('spaceId') spaceId: string,
  ): Promise<SpaceStatusResponse> {
    return this.engine.getStatus(request.user.sub, spaceId);
  }
}
