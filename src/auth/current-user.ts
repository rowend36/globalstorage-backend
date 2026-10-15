export interface CurrentUser {
  sub: string;
  email: string;
  jti: string;
  userVersion: number;
  tenantId?: string;
  roles: ReadonlyArray<{
    tenantId: string;
    tenantPath: string;
    includeDescendants: boolean;
    names: string[];
    claims: string[];
    platformClaims: string[];
    versions: ReadonlyArray<{ id: string; version: number }>;
  }>;
}
