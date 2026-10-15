import { BadRequestException } from '@nestjs/common';

export const MAX_KEY_LENGTH = 512;

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Normalizes and validates a logical key name. Keys are NFC-normalized so
 * equivalent Unicode spellings address the same value on every driver.
 */
export function validateKeyName(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BadRequestException('Key must not be empty');
  }
  const key = raw.normalize('NFC');
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new BadRequestException(
      `Key must be between 1 and ${MAX_KEY_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARS.test(key)) {
    throw new BadRequestException('Key must not contain control characters');
  }
  return key;
}

export function validateSpaceName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > 200) {
    throw new BadRequestException('Space name must be between 1 and 200 characters');
  }
  return name;
}
