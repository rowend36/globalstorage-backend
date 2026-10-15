import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import {
  ConsoleMailProvider,
  ResendMailProvider,
  SmtpMailProvider,
} from './mail.providers';
import { MAIL_PROVIDER, type MailPort } from './mail.port';
import { EmailTemplateEngine } from './template-engine';
import { TemplatedMailService } from './templated-mail.service';
import { join } from 'node:path';

@Global()
@Module({
  providers: [
    ConsoleMailProvider,
    SmtpMailProvider,
    ResendMailProvider,
    {
      provide: EmailTemplateEngine,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new EmailTemplateEngine(
          [join(__dirname, 'templates')],
          config.get('mail.frontendUrl', { infer: true }),
        ),
    },
    TemplatedMailService,
    {
      provide: MAIL_PROVIDER,
      inject: [
        ConfigService,
        ConsoleMailProvider,
        SmtpMailProvider,
        ResendMailProvider,
      ],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        consoleProvider: ConsoleMailProvider,
        smtpProvider: SmtpMailProvider,
        resendProvider: ResendMailProvider,
      ): MailPort => {
        const provider = config.get('mail.provider', { infer: true });
        if (provider === 'smtp') return smtpProvider;
        if (provider === 'resend') return resendProvider;
        if (provider === 'console') return consoleProvider;
        throw new Error(`Unsupported mail provider: ${provider}`);
      },
    },
  ],
  exports: [MAIL_PROVIDER, TemplatedMailService],
})
export class MailModule {}
