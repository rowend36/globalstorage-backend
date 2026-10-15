import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  MAIL_PROVIDER,
  type MailAttachment,
  type MailPort,
} from './mail.port';
import { EmailTemplateEngine, type TemplateContext } from './template-engine';
import { TelemetryService } from '../telemetry.service';

@Injectable()
export class TemplatedMailService {
  constructor(
    @Inject(MAIL_PROVIDER) private readonly mail: MailPort,
    private readonly templates: EmailTemplateEngine,
    private readonly telemetry: TelemetryService,
    private readonly logger: PinoLogger,
  ) {}

  async send(input: {
    to: string;
    subject: string;
    template: string;
    textTemplate?: string;
    context?: TemplateContext;
    attachments?: readonly MailAttachment[];
  }): Promise<void> {
    let messageId: string | undefined;
    try {
      await this.telemetry.run('mail.send', async () => {
        const html = this.templates.render(input.template, input.context);
        const text = input.textTemplate
          ? this.templates.render(input.textTemplate, input.context)
          : undefined;
        const result = await this.mail.send({
          to: input.to,
          subject: input.subject,
          html,
          text,
          attachments: input.attachments,
        });
        messageId = result.messageId;
      }, { 'mail.template': input.template });
      this.logger.info(
        { messageId, to: input.to, template: input.template },
        'mail.send accepted',
      );
    } catch (error) {
      this.logger.error(
        { err: error, to: input.to, template: input.template },
        'mail.send failed',
      );
      throw error;
    }
  }
}
