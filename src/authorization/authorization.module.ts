import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ClaimsGuard } from './claims.guard';
import { AuthorizationVersionService } from './authorization-version.service';
import { TenantAccessAdminService } from './tenant-access-admin.service';
import { TenantAccessAdminController } from './tenant-access-admin.controller';
@Module({
  controllers: [TenantAccessAdminController],
  providers: [
    AuthorizationVersionService,
    TenantAccessAdminService,
    { provide: APP_GUARD, useClass: ClaimsGuard },
  ],
  exports: [AuthorizationVersionService, TenantAccessAdminService],
})
export class AuthorizationModule {}
