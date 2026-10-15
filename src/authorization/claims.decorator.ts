import { SetMetadata } from '@nestjs/common';
export const REQUIRED_CLAIMS = 'required_claims';
export const RequireClaims = (...claims: string[]) =>
  SetMetadata(REQUIRED_CLAIMS, claims);
