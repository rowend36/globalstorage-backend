import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { JwtStrategy } from './jwt.strategy';
import { AppConfig } from '../config/configuration';
import { MailModule } from '../mail/mail.module';
import { SuperAdminCommand } from './super-admin.command';

@Module({
  imports: [
    PassportModule,
    MailModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        secret: config.get('auth.jwtSecret', { infer: true }),
        signOptions: {
          expiresIn: config.get('auth.jwtExpiresIn', { infer: true }),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, MfaService, SuperAdminCommand],
  exports: [AuthService, MfaService],
})
export class AuthModule {}
