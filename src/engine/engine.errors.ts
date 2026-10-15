import {
  ForbiddenException,
  PreconditionFailedException,
} from '@nestjs/common';

export class QuotaExceededException extends ForbiddenException {
  constructor(limit: 'space' | 'aggregate') {
    super({
      code: 'quota_exceeded',
      limit,
      message: `Storage quota exceeded (${limit} limit)`,
    });
  }
}

export class KeyVersionConflictException extends PreconditionFailedException {
  constructor(currentVersion: number) {
    super({
      code: 'version_conflict',
      currentVersion,
      message: `Key version mismatch; current version is ${currentVersion}`,
    });
  }
}
