import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OidcController } from './oidc.controller';
import { OidcService } from './oidc.service';
@Module({
  imports: [AuthModule],
  controllers: [OidcController],
  providers: [OidcService],
  exports: [OidcService],
})
export class OidcModule {}
