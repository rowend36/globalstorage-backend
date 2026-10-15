import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RequireClaims } from '../authorization/claims.decorator';
import { TriggerBatchDto, TriggerChunkedDto, TriggerJobDto } from './jobs.dto';
import { JobsService } from './jobs.service';
import { ApiBearerAuth, ApiBody, ApiExtraModels, ApiOkResponse, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';

class ScheduledJobResponse {
  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'number' }] }) id!: string | number;
  @ApiProperty() handler!: string;
  @ApiProperty({ enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] }) status!: string;
}

class BatchResponse {
  @ApiProperty() scheduled!: number;
  @ApiProperty({ type: [ScheduledJobResponse] }) jobs!: ScheduledJobResponse[];
}

class ChunkedResponse extends BatchResponse {
  @ApiProperty() chunkSize!: number;
}

@Controller('jobs')
@UseGuards(AuthGuard('jwt'))
@RequireClaims('jobs.manage')
@ApiTags('jobs')
@ApiBearerAuth()
@ApiExtraModels(ScheduledJobResponse, BatchResponse, ChunkedResponse)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post('trigger')
  @ApiOperation({ summary: 'Trigger one job' })
  @ApiBody({ type: TriggerJobDto })
  @ApiOkResponse({ type: ScheduledJobResponse })
  async trigger(@Body() dto: TriggerJobDto) {
    return this.jobs.triggerJob(dto);
  }

  @Post('batch')
  @ApiOperation({ summary: 'Trigger a batch of jobs' })
  @ApiBody({ type: TriggerBatchDto })
  @ApiOkResponse({ type: BatchResponse })
  async batch(@Body() dto: TriggerBatchDto) {
    return this.jobs.triggerBatch(dto);
  }

  @Post('chunked')
  @ApiOperation({ summary: 'Trigger jobs in chunks' })
  @ApiBody({ type: TriggerChunkedDto })
  @ApiOkResponse({ type: ChunkedResponse })
  async chunked(@Body() dto: TriggerChunkedDto) {
    return this.jobs.triggerChunked(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List jobs' })
  @ApiQuery({ name: 'status', required: false })
  @ApiOkResponse({ description: 'Scheduled jobs', schema: { type: 'array', items: { $ref: '#/components/schemas/ScheduledJobResponse' } } })
  async list(@Query('status') status?: string) {
    return this.jobs.listJobs(status);
  }
}
