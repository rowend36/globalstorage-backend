import { Module } from '@nestjs/common';
import { AppModule } from '../app.module';
import { MailCommandsModule } from '../mail/mail.commands.module';

/**
 * CLI composition root. Feature modules should expose their command providers
 * through modules imported here; files are not discovered by directory scan.
 */
@Module({ imports: [AppModule, MailCommandsModule] })
export class CommandsModule {}
