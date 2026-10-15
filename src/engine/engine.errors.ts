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
  constructor(currentVersion: number | null) {
    super({
      code: 'version_conflict',
      currentVersion,
      message:
        currentVersion === null
          ? 'Key does not exist'
          : `Key version mismatch; current version is ${currentVersion}`,
    });
  }
}
