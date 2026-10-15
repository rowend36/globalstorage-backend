import { Module } from '@nestjs/common';
import { MailModule } from './mail.module';
import { SendTestMailCommand } from './send-test-mail.command';

@Module({
  imports: [MailModule],
  providers: [SendTestMailCommand],
})
export class MailCommandsModule {}