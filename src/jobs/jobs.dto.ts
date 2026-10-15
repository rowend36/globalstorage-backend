import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TriggerJobDto {
  @ApiProperty({ maxLength: 100, minLength: 1, example: 'example.ping' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  handler!: string;

  @IsOptional()
  @ApiPropertyOptional({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @ApiPropertyOptional({ type: Object })
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @ApiPropertyOptional({ format: 'date-time' })
  @IsISO8601()
  runAt?: string;

  @IsOptional()
  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;
}

export class TriggerBatchDto {
  @ApiProperty({ maxLength: 100, minLength: 1, example: 'example.ping' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  handler!: string;

  @IsArray()
  @ApiProperty({ type: [Object], minItems: 1, maxItems: 500 })
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsObject({ each: true })
  payloads!: Array<Record<string, unknown>>;

  @IsOptional()
  @ApiPropertyOptional({ format: 'date-time' })
  @IsISO8601()
  runAt?: string;

  @IsOptional()
  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;
}

export class TriggerChunkedDto {
  @ApiProperty({ maxLength: 100, minLength: 1, example: 'example.ping' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  handler!: string;

  @IsArray()
  @ApiProperty({ type: [Object], minItems: 1 })
  @ArrayMinSize(1)
  items!: unknown[];

  @IsOptional()
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsInt()
  @Min(1)
  @Max(200)
  chunkSize?: number;

  @IsOptional()
  @ApiPropertyOptional({ format: 'date-time' })
  @IsISO8601()
  runAt?: string;

  @IsOptional()
  @ApiPropertyOptional({ minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;
}

export type TriggerJobInput = TriggerJobDto;
export type TriggerBatchInput = TriggerBatchDto;
export type TriggerChunkedInput = TriggerChunkedDto;
