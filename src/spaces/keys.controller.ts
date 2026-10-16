import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { StorageEngineService } from '../engine/engine.service';
import type { CurrentUser } from '../auth/current-user';

class WriteKeyResponse {
  @ApiProperty() key!: string;
  @ApiProperty({ description: 'Committed logical version (timestamp)' }) version!: number;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() spaceUsedBytes!: number;
  @ApiProperty() spaceQuotaBytes!: number;
}

class DeleteKeyResponse {
  @ApiProperty() key!: string;
  @ApiProperty() version!: number;
}

class KeyEntryResponse {
  @ApiProperty() key!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true }) contentType!: string | null;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ nullable: true }) updatedAt!: Date | null;
  @ApiProperty({ enum: ['pending', 'persisted'] }) status!: 'pending' | 'persisted';
}

class ListKeysResponse {
  @ApiProperty({ type: [KeyEntryResponse] }) keys!: KeyEntryResponse[];
  @ApiProperty({ nullable: true }) nextCursor!: string | null;
}

const MAX_CONTENT_TYPE_LENGTH = 255;

function parsePreconditions(
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
): number | null | 'exists' | undefined {
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() !== '*') {
      throw new BadRequestException('Only If-None-Match: * is supported');
    }
    if (ifMatch !== undefined) {
      throw new BadRequestException('If-Match and If-None-Match are mutually exclusive');
    }
    return null;
  }
  if (ifMatch === undefined) return undefined;
  if (ifMatch.trim() === '*') return 'exists';
  const version = Number(ifMatch);
  if (!Number.isInteger(version) || version < 0) {
    throw new BadRequestException('If-Match must carry a key version timestamp or *');
  }
  return version;
}

function rawBodyBytes(body: unknown, request: Request): Buffer {
  if (Buffer.isBuffer(body)) return body;
  // Empty bodies arrive without a parsed representation.
  const contentLength = Number(request.get('content-length') ?? 0);
  if (
    (body === undefined || body === null ||
      (typeof body === 'object' && Object.keys(body).length === 0)) &&
    contentLength === 0
  ) {
    return Buffer.alloc(0);
  }
  throw new BadRequestException('Expected a raw value body');
}

@Controller('spaces/:spaceId/keys')
@ApiTags('keys')
@UseGuards(AuthGuard('jwt'))
@ApiBearerAuth()
export class KeysController {
  constructor(private readonly engine: StorageEngineService) {}

  @Get()
  @ApiOperation({ summary: 'List keys with prefix filtering and keyset pagination' })
  @ApiQuery({ name: 'prefix', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: ListKeysResponse })
  async list(
    @Req() request: Request & { user: CurrentUser },
    @Param('spaceId') spaceId: string,
    @Query('prefix') prefix?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<ListKeysResponse> {
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      limit = Number.parseInt(limitRaw, 10);
      if (!Number.isInteger(limit)) throw new BadRequestException('limit must be an integer');
    }
    return this.engine.listKeys({
      ownerId: request.user.sub,
      spaceId,
      prefix,
      cursor,
      limit,
    });
  }

  @Put('*key')
  @ApiOperation({ summary: 'Create or replace a value (raw request body)' })
  @ApiParam({ name: 'key', description: 'URL-encoded logical key, e.g. todos%2F123' })
  @ApiConsumes('*/*')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOkResponse({ type: WriteKeyResponse })
  async write(
    @Req() request: Request & { user: CurrentUser } & { body?: unknown },
    @Param('spaceId') spaceId: string,
    @Param('key') key: string,
    @Headers('if-match') ifMatch?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
  ): Promise<WriteKeyResponse> {
    const value = rawBodyBytes(request.body, request);
    const contentTypeHeader = request.get('content-type');
    const contentType = contentTypeHeader?.split(';')[0]?.trim() || null;
    if (contentType && contentType.length > MAX_CONTENT_TYPE_LENGTH) {
      throw new BadRequestException('Content-Type value is too long');
    }
    return this.engine.writeKey({
      ownerId: request.user.sub,
      spaceId,
      key,
      value,
      contentType,
      expectedVersion: parsePreconditions(ifMatch, ifNoneMatch),
    });
  }

  @Get('*key')
  @ApiOperation({ summary: 'Read a value (raw bytes with the stored content type)' })
  @ApiParam({ name: 'key', description: 'URL-encoded logical key, e.g. todos%2F123' })
  async read(
    @Req() request: Request & { user: CurrentUser },
    @Param('spaceId') spaceId: string,
    @Param('key') key: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const result = await this.engine.readKey({
      ownerId: request.user.sub,
      spaceId,
      key,
    });
    response.set({
      'Content-Type': result.contentType ?? 'application/octet-stream',
      'Content-Length': String(result.value.length),
      'X-Key-Version': String(result.version),
    });
    response.send(result.value);
  }

  @Delete('*key')
  @ApiOperation({ summary: 'Delete a value' })
  @ApiParam({ name: 'key', description: 'URL-encoded logical key, e.g. todos%2F123' })
  @ApiOkResponse({ type: DeleteKeyResponse })
  async remove(
    @Req() request: Request & { user: CurrentUser },
    @Param('spaceId') spaceId: string,
    @Param('key') key: string,
  ): Promise<DeleteKeyResponse> {
    return this.engine.deleteKey({ ownerId: request.user.sub, spaceId, key });
  }
}
